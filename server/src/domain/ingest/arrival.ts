/**
 * 实时入库（ingest）的领域规则：一张照片「到了」要满足什么，以及「到齐」怎么判定。
 *
 * 三条规则，全是纯计算：
 *  1. **临时名不算到达**：上传工具/相机写到一半常用 `.part`、`.tmp`、点开头的影子名，这些一律忽略；
 *  2. **稳定才算写完**（{@link StabilityPolicy}）：大小 + mtime 连续 `quietMs` 没变、且大小 > 0；
 *     来源自己能保证原子落盘（FTP 适配器写临时名再改名）时可以跳过观察；
 *  3. **配对窗口**（{@link PairingWindow}）：RAW+JPEG 是先后到的两个文件。同一目录最后一次到达后
 *     再等 `windowMs` 才入库一次 —— 不会出现「先入一张 JPEG，几百毫秒后又变成 RAW+JPEG」的闪烁。
 */

import { classify, isJunkFile } from '../exts.ts';

/** 一次到达：某个项目（根）下某个相对目录里的一个文件 */
export interface IngestedFile {
  readonly rootId: string;
  /** 根下的相对目录（`/` 分隔，根本身是 ''） */
  readonly relDir: string;
  readonly name: string;
  readonly size: number;
  /** 毫秒时间戳 */
  readonly at: number;
  readonly source: IngestSourceKind;
}

export type IngestSourceKind = 'ftp' | 'watch';

const PARTIAL_SUFFIXES = ['.part', '.partial', '.tmp', '.temp', '.filepart', '.crdownload', '.download', '.ffpart'];

/** 写到一半的影子名（或垃圾文件）：不触发入库 */
export function isPartialName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('~')) return true;
  if (isJunkFile(name)) return true;
  return PARTIAL_SUFFIXES.some((s) => lower.endsWith(s));
}

/** 只有照片 / 视频才值得入库（XMP 等影子文件跟着主文件走，下次扫描自然带上） */
export function isIngestible(name: string): boolean {
  if (isPartialName(name)) return false;
  const cat = classify(name);
  return cat === 'raw' || cat === 'image' || cat === 'video';
}

export interface FileObservation {
  readonly size: number;
  readonly mtimeMs: number;
  /** 观察时刻（毫秒） */
  readonly at: number;
}

export type Stability = { readonly state: 'stable' } | { readonly state: 'pending'; readonly recheckInMs: number } | { readonly state: 'gone' };

/** 写入稳定判定：同一文件的连续两次观察 */
export class StabilityPolicy {
  readonly quietMs: number;

  constructor(quietMs: number) {
    if (!Number.isFinite(quietMs) || quietMs < 0) throw new Error(`quietMs 必须是非负数：${quietMs}`);
    this.quietMs = quietMs;
  }

  /**
   * prev = 上一次观察（第一次为 null），now = 这一次（文件不见了为 null）。
   * 判 stable 的条件：两次大小、mtime 一致，大小 > 0，且间隔不短于 quietMs。
   */
  judge(prev: FileObservation | null, now: FileObservation | null): Stability {
    if (!now) return { state: 'gone' };
    if (!prev || prev.size !== now.size || prev.mtimeMs !== now.mtimeMs || now.size === 0) {
      return { state: 'pending', recheckInMs: Math.max(this.quietMs, 1) };
    }
    const waited = now.at - prev.at;
    if (waited < this.quietMs) return { state: 'pending', recheckInMs: this.quietMs - waited };
    return { state: 'stable' };
  }
}

/** 目录键：同一个根 + 相对目录 */
export const dirKey = (rootId: string, relDir: string): string => `${rootId}\u0000${relDir}`;

export interface DueDir {
  readonly rootId: string;
  readonly relDir: string;
  readonly files: readonly IngestedFile[];
}

/** 配对窗口：按目录攒到达，最后一次到达后静默 windowMs 才放行 */
export class PairingWindow {
  readonly windowMs: number;
  private readonly pending = new Map<string, { rootId: string; relDir: string; last: number; files: IngestedFile[] }>();

  constructor(windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error(`windowMs 必须是非负数：${windowMs}`);
    this.windowMs = windowMs;
  }

  /** 记一次到达；返回这个目录下一次该检查的时刻 */
  add(file: IngestedFile): number {
    const key = dirKey(file.rootId, file.relDir);
    const cur = this.pending.get(key) ?? { rootId: file.rootId, relDir: file.relDir, last: 0, files: [] };
    cur.last = Math.max(cur.last, file.at);
    cur.files = [...cur.files.filter((f) => f.name !== file.name), file];
    this.pending.set(key, cur);
    return cur.last + this.windowMs;
  }

  /** 取出所有窗口已过的目录（取出即移除） */
  takeDue(now: number): DueDir[] {
    const due: DueDir[] = [];
    for (const [key, cur] of this.pending) {
      if (now - cur.last < this.windowMs) continue;
      this.pending.delete(key);
      due.push({ rootId: cur.rootId, relDir: cur.relDir, files: cur.files });
    }
    return due;
  }

  /** 最早的到期时刻（没有待办 = null） */
  nextDueAt(): number | null {
    let min: number | null = null;
    for (const cur of this.pending.values()) {
      const t = cur.last + this.windowMs;
      if (min === null || t < min) min = t;
    }
    return min;
  }

  get size(): number {
    return this.pending.size;
  }
}

/** 落盘目录模板：`{date}` → 当天 YYYY-MM-DD（本地时区由调用方给）。只允许安全的相对路径 */
export function expandInboxDir(template: string, today: string): string {
  const out = template.replaceAll('{date}', today).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (out.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error(`ingest 子目录不能含 . 或 ..：${template}`);
  return out;
}
