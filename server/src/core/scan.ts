/**
 * 扫描：把磁盘目录变成「照片实体」列表。
 *
 * 三条来自票 001 的规则，都在这里落地：
 *  1. **配对**：同目录 + **大小写不敏感**同名 + 扩展名分类；多个 RAW 取扩展名字母序最早的那个；
 *  2. **元数据缓存**：键是 `path+mtime+size`，三者不变就复用上次扫描的结果（NAS 上 exiftool 是慢环节）；
 *  3. **成对为一等实体**：RAW 和 JPEG 是同一个 `PhotoRecord` 的两条腿，绝不各自成对。
 *
 * 每次扫描**重建配对**（目录内很便宜），但**不重算元数据**（这才贵）。索引本身可重建，
 * 真正的状态（XMP / 日志）不在索引里。
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FileMeta, FileRef, PhotoRecord, PreviewSource } from './photo.ts';
import { classify, extOf, isJunkFile, stemOf } from './exts.ts';
import { encodePhotoId } from './ids.ts';
import { readMetas } from './exif.ts';
import { readXmpMarks } from './xmp.ts';

export interface RootCfg {
  id: string;
  label: string;
  path: string;
}

export interface CachedMeta {
  mtimeMs: number;
  size: number;
  meta: FileMeta;
}

export interface ScanOptions {
  roots: RootCfg[];
  ignore: string[];
  maxDepth: number;
  metaCache: Map<string, CachedMeta>;
  /** 这里返回 true 表示某个 RAW 的内嵌预览已经抽出来了（缓存文件存在），可以让 DTO 报 embedded_jpeg */
  hasExtractedPreview?: (rec: { absStem: string; sig: string }) => boolean;
  onError?: (message: string, err: unknown) => void;
}

export interface ScanResult {
  records: PhotoRecord[];
  metaCache: Map<string, CachedMeta>;
  online: Map<string, boolean>;
  fileCount: number;
  errors: string[];
}

interface Found extends FileRef {
  ext: string;
  name: string;
}
interface Group {
  relDir: string;
  stem: string;
  absDir: string;
  raw?: Found;
  image?: Found;
  video?: Found;
}

export async function scanLibrary(opts: ScanOptions): Promise<ScanResult> {
  const ignore = new Set(opts.ignore.map((s) => s.toLowerCase()));
  const records: PhotoRecord[] = [];
  const online = new Map<string, boolean>();
  const metaCache = new Map<string, CachedMeta>();
  const errors: string[] = [];
  let fileCount = 0;

  const onError = (message: string, err: unknown) => {
    const text = `${message}: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(text);
    opts.onError?.(message, err);
  };

  for (const root of opts.roots) {
    const rootAbs = resolve(root.path);
    if (!existsSync(rootAbs)) {
      online.set(root.id, false);
      continue;
    }
    online.set(root.id, true);

    const stack: { abs: string; rel: string; depth: number }[] = [{ abs: rootAbs, rel: '', depth: 0 }];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries;
      try {
        entries = await readdir(cur.abs, { withFileTypes: true });
      } catch (err) {
        onError(`读不了目录 ${cur.abs}`, err);
        continue;
      }

      const groups = new Map<string, Group>();
      for (const entry of entries) {
        const name = entry.name;
        if (entry.isDirectory()) {
          if (cur.depth + 1 <= opts.maxDepth && !ignore.has(name.toLowerCase())) {
            stack.push({ abs: join(cur.abs, name), rel: cur.rel ? `${cur.rel}/${name}` : name, depth: cur.depth + 1 });
          }
          continue;
        }
        if (entry.isSymbolicLink()) continue; // 不跟软链：NAS 上绕圈是经典事故
        if (!entry.isFile()) continue;

        if (isJunkFile(name)) continue; // .DS_Store / ._X.JPG / Thumbs.db
        const cat = classify(name);
        if (cat === 'other' || cat === 'sidecar') continue;

        let st;
        try {
          st = await stat(join(cur.abs, name));
        } catch {
          continue; // 扫描一瞬文件被移走：不是错误
        }
        fileCount++;

        const key = stemOf(name).toLowerCase();
        let group = groups.get(key);
        if (!group) {
          group = { relDir: cur.rel, stem: stemOf(name), absDir: cur.abs };
          groups.set(key, group);
        }
        const found: Found = { path: join(cur.abs, name), name, ext: extOf(name), mtimeMs: st.mtimeMs, size: st.size };
        if (cat === 'raw') {
          if (!group.raw || found.ext < group.raw.ext) group.raw = found;
        } else if (cat === 'image') {
          if (!group.image || found.ext < group.image.ext) group.image = found;
        } else if (cat === 'video') {
          if (!group.video || found.ext < group.video.ext) group.video = found;
        }
      }

      for (const group of groups.values()) {
        const rec = await buildRecord(root.id, group, opts, metaCache);
        if (rec) records.push(rec);
      }
    }
  }

  // 元数据：只有「三件套变了」或第一次见的文件才重算
  const stale: string[] = [];
  for (const rec of records) {
    const src = rec.jpeg ?? rec.raw;
    if (!src) continue;
    const cached = metaCache.get(rec.previewPath);
    if (cached && cached.mtimeMs === src.mtimeMs && cached.size === src.size) {
      rec.meta = cached.meta;
    } else {
      stale.push(rec.previewPath);
    }
  }

  if (stale.length) {
    const fresh = await readMetas(stale, (path, err) => onError(`exiftool 读不了 ${path}`, err));
    for (const rec of records) {
      const src = rec.jpeg ?? rec.raw;
      if (!src) continue;
      const meta = fresh.get(rec.previewPath);
      if (meta) {
        rec.meta = meta;
        metaCache.set(rec.previewPath, { mtimeMs: src.mtimeMs, size: src.size, meta });
      }
    }
  }

  return { records, metaCache, online, fileCount, errors };
}

async function buildRecord(
  rootId: string,
  group: Group,
  opts: ScanOptions,
  _metaCache: Map<string, CachedMeta>,
): Promise<PhotoRecord | null> {
  const main = group.raw ?? group.image ?? group.video;
  if (!main) return null;

  const displayName = main.name.slice(0, main.name.length - main.ext.length);
  const relStem = group.relDir ? `${group.relDir}/${displayName}` : displayName;
  const absStem = join(group.absDir, displayName);
  const previewPath = (group.image ?? group.raw ?? group.video)!.path;

  let previewSource: PreviewSource = 'pending';
  if (group.image) previewSource = 'external_jpeg';
  else if (group.raw && opts.hasExtractedPreview) {
    const sig = `${Math.floor(group.raw.mtimeMs)}-${group.raw.size}`;
    if (opts.hasExtractedPreview({ absStem, sig })) previewSource = 'embedded_jpeg';
  }

  const marks = readXmpMarks(`${absStem}.xmp`) ?? readXmpMarks(main.path + '.xmp') ?? null;

  return {
    id: encodePhotoId(rootId, relStem),
    rootId,
    relDir: group.relDir,
    relStem,
    displayName,
    kind: group.raw || group.image ? 'photo' : 'video',
    raw: group.raw ? { path: group.raw.path, mtimeMs: group.raw.mtimeMs, size: group.raw.size, ext: group.raw.ext } : undefined,
    jpeg: group.image ? { path: group.image.path, mtimeMs: group.image.mtimeMs, size: group.image.size, ext: group.image.ext } : undefined,
    previewPath,
    previewSource,
    meta: {},
    stars: marks?.stars ?? 0,
    del: marks?.del ?? false,
    focusHint: null,
  };
}
