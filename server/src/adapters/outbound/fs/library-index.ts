/**
 * `dataDir/index.json`（可重建的扫描缓存）与 `removed-roots.json`（已移除根的墓碑）的读写。
 * 两者坏了/删了都只是下次扫慢一点。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhotoRecord } from '../../../domain/photo.ts';
import type { CachedMeta } from './scan.ts';

/**
 * 索引文件版本。
 * 1 → 只存 `metaCache`（EXIF 缓存），照片列表靠每次启动重扫；
 * 2 → 连 `records` 一起存，冷启动可以**不碰文件系统**先把列表端出来（随后后台扫描校正）。
 */
const INDEX_VERSION = 2;

/** `index.json` 的形状。缓存坏了、版本不认，就当没有 —— 扫描能重建一切。 */
export interface IndexFile {
  version?: number;
  savedAt?: string;
  lastScanAt?: string | null;
  fileCount?: number;
  online?: Record<string, boolean>;
  /** 每个根上次判离线的原因（给 `/roots` 的 `lastError`） */
  rootErrors?: Record<string, string>;
  records?: PhotoRecord[];
  metaCache?: Record<string, CachedMeta>;
}

export type RemovedRoot = { id: string; path: string };

/** 反序列化的最小校验：缺胳膊少腿的记录宁可丢掉，不能让它带坏整棵目录树。 */
function isPhotoRecord(v: unknown): v is PhotoRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<PhotoRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.rootId === 'string' &&
    typeof r.relDir === 'string' &&
    typeof r.previewPath === 'string' &&
    (r.kind === 'photo' || r.kind === 'video')
  );
}

export class LibraryIndexFiles {
  private readonly indexFile: string;
  private readonly removedFile: string;

  constructor(dataDir: string) {
    this.indexFile = join(dataDir, 'index.json');
    this.removedFile = join(dataDir, 'removed-roots.json');
  }

  /** 认得的版本才返回；`records` 已过滤成合法记录 */
  readIndex(): IndexFile | null {
    if (!existsSync(this.indexFile)) return null;
    let raw: IndexFile | null;
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8')) as IndexFile;
    } catch {
      return null; // 索引坏了不是问题：下次扫描会重建
    }
    if (raw?.version !== INDEX_VERSION) return null; // 老版本（或将来更新的）一律丢掉重扫
    return { ...raw, records: (raw.records ?? []).filter(isPhotoRecord) };
  }

  writeIndex(data: Omit<IndexFile, 'version' | 'savedAt'>): void {
    try {
      writeFileSync(this.indexFile, JSON.stringify({ version: INDEX_VERSION, savedAt: new Date().toISOString(), ...data }), 'utf8');
    } catch {
      // 写不动就算了
    }
  }

  readRemovedRoots(): RemovedRoot[] {
    try {
      const raw = JSON.parse(readFileSync(this.removedFile, 'utf8'));
      if (Array.isArray(raw)) {
        return raw.filter((t): t is RemovedRoot => t && typeof t.id === 'string' && typeof t.path === 'string');
      }
    } catch {
      /* 没有或坏了就当空 —— 墓碑只是优化，不是账本 */
    }
    return [];
  }

  writeRemovedRoots(roots: RemovedRoot[]): void {
    writeFileSync(this.removedFile, JSON.stringify(roots, null, 2), 'utf8');
  }
}
