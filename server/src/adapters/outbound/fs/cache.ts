/**
 * 预览缓存的容量策略（票 013，落地票 005 Resolution 条目 3）。
 *
 * 缓存是**可重建**的（缩略图丢了再生成一张就是），所以这里的规则很短：
 *
 *  1. 上限可配（`cache.maxBytes`，默认 8 GB；`0` = 不限）：超了就从**最久没读过**的删起，
 *     删到上限的 90% 就停 —— 不删到刚好压线，否则下一次写几张就又要整轮扫。
 *  2. 单轮有预算（默认最多看 2000 个文件）：大库启动时不为了统计把目录读穿；
 *     够不到的部分留给下一轮（sweep 会周期性再跑）。
 *
 * 「最久没读过」用 atime。本地盘默认 relatime，只有 atime 比 mtime 旧或超过 24 小时才会更新，
 * 所以光靠读文件不够 —— `Thumbs` 命中缓存时会把太旧的 atime 主动刷新一下（见 `touchIfStale`）。
 *
 * 正在生成的预览不能删：`isProtected` 由 `Thumbs` 的 in-flight 集合提供（票 013 验收条目）。
 */

import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/** 删到上限的这个比例就停 */
const TARGET_RATIO = 0.9;
/** 单轮最多看多少个文件 */
const DEFAULT_SCAN_LIMIT = 2000;
/** 缓存命中时，atime 比这个还旧就主动刷一次（relatime 下不刷就等于没有 LRU） */
const TOUCH_AFTER_MS = 60 * 60_000;
/** 半截产物（进程崩在写盘中间）超过这个岁数就清掉 */
const TMP_STALE_MS = 60 * 60_000;

export interface CacheEvictResult {
  at: string;
  /** 本轮看了多少个文件 */
  scanned: number;
  deleted: number;
  freedBytes: number;
  /** 本轮看到的缓存占用（`truncated` 时只是看到的那部分） */
  bytes: number;
  files: number;
  /** 本轮没看完（撞上单轮预算），下一轮接着来 */
  truncated: boolean;
}

export interface CacheStats {
  bytes: number;
  files: number;
  /** 0 = 不限 */
  maxBytes: number;
  lastEvict: CacheEvictResult | null;
}

interface CacheEntry {
  path: string;
  size: number;
  atimeMs: number;
  /** 半截产物：不管上限都要清 */
  tmp: boolean;
}

/**
 * 命中缓存时刷一下 atime（本地盘 relatime 下，不刷就等于没有 LRU）。
 * 只在本来的 atime 已经够旧时才写，正常读片不会每条请求都动元数据。
 */
export async function touchIfStale(path: string, now = Date.now()): Promise<void> {
  try {
    const st = await stat(path);
    if (now - st.atimeMs < TOUCH_AFTER_MS) return;
    await utimes(path, now / 1000, now / 1000);
  } catch {
    // 文件可能刚被淘汰：不是错误
  }
}

export class CacheJanitor {
  private readonly dirs: string[];
  private readonly maxBytes: number;
  private readonly scanLimit: number;
  private readonly isProtected: (path: string) => boolean;
  private bytes = 0;
  private files = 0;
  private lastEvict: CacheEvictResult | null = null;

  constructor(opts: { dirs: string[]; maxBytes: number; isProtected?: (path: string) => boolean; scanLimit?: number }) {
    this.dirs = opts.dirs;
    this.maxBytes = opts.maxBytes;
    this.scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.isProtected = opts.isProtected ?? (() => false);
  }

  /** 只统计不删：启动时先把数字端出来（`/capabilities.library.cache`） */
  async measure(): Promise<{ bytes: number; files: number; truncated: boolean }> {
    const { bytes, files, truncated } = await this.walk();
    this.bytes = bytes;
    this.files = files;
    return { bytes, files, truncated };
  }

  /**
   * 一轮淘汰：超上限就删到 90%，顺便清掉半截产物。
   * 返回 null = 上限关着（`maxBytes <= 0`），什么都不碰。
   */
  async sweep(): Promise<CacheEvictResult | null> {
    if (this.maxBytes <= 0) return null;
    const target = Math.floor(this.maxBytes * TARGET_RATIO);
    const { entries, bytes, files, truncated } = await this.walk();
    const result: CacheEvictResult = {
      at: new Date().toISOString(),
      scanned: entries.length,
      deleted: 0,
      freedBytes: 0,
      bytes,
      files,
      truncated,
    };

    // 半截产物先清（不管容量，它们永远不会被读到，也不计入「缓存占用」）
    for (const e of entries.filter((e) => e.tmp)) {
      if (await this.remove(e.path)) {
        result.deleted++;
        result.freedBytes += e.size;
      }
    }

    // 没超上限 → 什么都别做；超了就按 atime 从旧到新删到 90%
    const alive = entries.filter((e) => !e.tmp);
    const overLimit = truncated || result.bytes > this.maxBytes;
    if (overLimit) {
      alive.sort((a, b) => a.atimeMs - b.atimeMs); // 最久没读的排前面
      for (const e of alive) {
        if (result.bytes <= target) break;
        if (this.isProtected(e.path)) continue; // 正在生成的预览：这一轮跳过，下一轮再说
        if (await this.remove(e.path)) {
          result.deleted++;
          result.freedBytes += e.size;
          result.bytes -= e.size;
          result.files--;
        }
      }
    }

    this.bytes = result.bytes;
    this.files = result.files;
    this.lastEvict = result;
    return result;
  }

  stats(): CacheStats {
    return { bytes: this.bytes, files: this.files, maxBytes: this.maxBytes, lastEvict: this.lastEvict };
  }

  private async remove(path: string): Promise<boolean> {
    try {
      await rm(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 走一遍缓存目录，最多看 `scanLimit` 个文件 */
  private async walk(): Promise<{ entries: CacheEntry[]; bytes: number; files: number; truncated: boolean }> {
    const entries: CacheEntry[] = [];
    let bytes = 0;
    let files = 0;
    let truncated = false;
    const now = Date.now();
    for (const dir of this.dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // 目录还没建出来：没有缓存
      }
      for (const name of names) {
        if (entries.length >= this.scanLimit) {
          truncated = true;
          break;
        }
        const path = join(dir, name);
        const st = await stat(path).catch(() => null);
        if (!st?.isFile()) continue;
        const tmp = name.endsWith('.tmp');
        entries.push({ path, size: st.size, atimeMs: st.atimeMs, tmp: tmp && now - st.mtimeMs > TMP_STALE_MS });
        if (!tmp) {
          bytes += st.size; // 半截产物不计入「缓存占用」
          files++;
        }
      }
      if (truncated) break;
    }
    return { entries, bytes, files, truncated };
  }
}
