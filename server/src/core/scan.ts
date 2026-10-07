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
  /**
   * 单个根目录的扫描超时（毫秒，0 = 不超时）。
   * 照片库可能躺在网络挂载上：挂载一旦失联，FS 调用**永不返回**。没有这道闸，
   * 一次挂死就把整个服务拖住（票 011 的事故现场）。超时只把**这个根**标离线，其余根照扫。
   */
  rootTimeoutMs?: number;
  onError?: (text: string) => void;
}

export interface RootState {
  online: boolean;
  /** 判离线的原因（给 `/roots` 的 `lastError` 用），在线时是 null */
  error: string | null;
  /** true = 这次是超时判离线（挂载失联），调用方据此进熔断（冷却期内不再碰它） */
  timedOut: boolean;
}

export interface ScanResult {
  records: PhotoRecord[];
  metaCache: Map<string, CachedMeta>;
  online: Map<string, boolean>;
  rootStates: Map<string, RootState>;
  fileCount: number;
  errors: string[];
}

const DEFAULT_ROOT_TIMEOUT_MS = 20_000;
/** exiftool 那一批的整体上限：单张挂死也不能让 `scanning` 永远挂着 */
const EXIF_BATCH_TIMEOUT_MS = 120_000;

/**
 * 测试钩子：让某个根表现得像「挂死的网络挂载」（调用永不返回）。
 * 真实挂死没法在 CI/本机复现（需要 root 去挂一个不回包的 NFS），所以用这个环境变量回归
 * 超时 + 熔断 + 「其余根不受影响」这套行为。只在 tools/e2e-hung-mount.mjs 里用。
 */
function fakeHang(rootId: string): boolean {
  return process.env['ARTWORKS_TEST_HANG_ROOT'] === rootId;
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

class RootTimeout extends Error {
  readonly rootId: string;

  constructor(rootId: string, ms: number) {
    super(`扫描超时（${Math.round(ms / 1000)} 秒没有响应）：${rootId}`);
    this.rootId = rootId;
  }
}

interface RootScanOut {
  records: PhotoRecord[];
  fileCount: number;
  errors: string[];
}

/**
 * 扫描一个根：**自己攒自己的结果**。
 * 为什么不让它直接往公共数组里塞：超时后这个函数还在后台跑（挂载恢复后它会自己返回），
 * 如果它还在写共享状态，就会把「已经放弃的这一轮」的脏数据混进下一轮的结果里。
 */
async function scanRoot(root: RootCfg, opts: ScanOptions): Promise<RootScanOut> {
  const records: PhotoRecord[] = [];
  const errors: string[] = [];
  let fileCount = 0;

  if (fakeHang(root.id)) await new Promise<never>(() => undefined); // 测试钩子：永不返回，等超时闸

  const rootAbs = resolve(root.path);
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: rootAbs, rel: '', depth: 0 }];
  const ignore = new Set(opts.ignore.map((s) => s.toLowerCase()));

  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch (err) {
      const text = `读不了目录 ${cur.abs}: ${err instanceof Error ? err.message : String(err)}`;
      // 根目录自己读不了 = 这个项目整个离线（挂载没了/路径挪了）；往下某层读不了只是局部坏点，不影响根的状态
      if (cur.depth === 0) throw new Error(text);
      errors.push(text);
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
      const rec = await buildRecord(root.id, group, opts, opts.metaCache);
      if (rec) records.push(rec);
    }
  }

  return { records, fileCount, errors };
}

/** 给一个根套上超时闸；超时/报错都只影响这个根，返回它自己的状态与结果 */
async function scanRootIsolated(
  root: RootCfg,
  opts: ScanOptions,
  timeoutMs: number,
): Promise<{ out: RootScanOut; state: RootState }> {
  const rootAbs = resolve(root.path);
  const work = scanRoot(root, opts);
  work.catch(() => undefined); // 超时被放弃的那份还在后台跑，别变成未处理拒绝

  if (timeoutMs <= 0) {
    try {
      return { out: await work, state: { online: true, error: null, timedOut: false } };
    } catch (err) {
      const text = `扫描项目失败：${rootAbs} —— ${err instanceof Error ? err.message : String(err)}`;
      return { out: { records: [], fileCount: 0, errors: [text] }, state: { online: false, error: text, timedOut: false } };
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RootTimeout(rootAbs, timeoutMs)), timeoutMs);
  });
  try {
    const out = await Promise.race([work, timeout]);
    return { out, state: { online: true, error: null, timedOut: false } };
  } catch (err) {
    if (err instanceof RootTimeout) {
      const text = `扫描超时：${Math.round(timeoutMs / 1000)} 秒没有响应，网络挂载可能已失联（${rootAbs}）`;
      return { out: { records: [], fileCount: 0, errors: [text] }, state: { online: false, error: text, timedOut: true } };
    }
    const text = `扫描项目失败：${rootAbs} —— ${err instanceof Error ? err.message : String(err)}`;
    return { out: { records: [], fileCount: 0, errors: [text] }, state: { online: false, error: text, timedOut: false } };
  } finally {
    clearTimeout(timer);
  }
}

export async function scanLibrary(opts: ScanOptions): Promise<ScanResult> {
  const records: PhotoRecord[] = [];
  const online = new Map<string, boolean>();
  const rootStates = new Map<string, RootState>();
  const metaCache = new Map<string, CachedMeta>();
  const errors: string[] = [];
  let fileCount = 0;

  const addError = (text: string) => {
    errors.push(text);
    opts.onError?.(text);
  };

  const timeoutMs = opts.rootTimeoutMs ?? DEFAULT_ROOT_TIMEOUT_MS;
  for (const root of opts.roots) {
    const { out, state } = await scanRootIsolated(root, opts, timeoutMs);
    for (const text of out.errors) addError(text);
    records.push(...out.records);
    fileCount += out.fileCount;
    online.set(root.id, state.online);
    rootStates.set(root.id, state);
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
    const fresh = await Promise.race([
      readMetas(stale, (path, err) => addError(`exiftool 读不了 ${path}: ${err instanceof Error ? err.message : String(err)}`)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIF_BATCH_TIMEOUT_MS).unref?.()),
    ]);
    if (fresh === null) addError(`exiftool 这一批超过 ${Math.round(EXIF_BATCH_TIMEOUT_MS / 1000)} 秒没读完：本轮先用缓存/空元数据，下次扫描再补`);
    for (const rec of records) {
      const src = rec.jpeg ?? rec.raw;
      if (!src) continue;
      const meta = fresh?.get(rec.previewPath);
      if (meta) {
        rec.meta = meta;
        metaCache.set(rec.previewPath, { mtimeMs: src.mtimeMs, size: src.size, meta });
      }
    }
  }

  return { records, metaCache, online, rootStates, fileCount, errors };
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
  } else if (group.video) previewSource = 'video_poster'; // 封面按需由 ffmpeg 抽帧（thumbs.ts）

  const marks = (await readXmpMarks(`${absStem}.xmp`)) ?? (await readXmpMarks(main.path + '.xmp')) ?? null;

  return {
    id: encodePhotoId(rootId, relStem),
    rootId,
    relDir: group.relDir,
    relStem,
    displayName,
    kind: group.raw || group.image ? 'photo' : 'video',
    raw: group.raw ? { path: group.raw.path, mtimeMs: group.raw.mtimeMs, size: group.raw.size, ext: group.raw.ext } : undefined,
    jpeg: group.image ? { path: group.image.path, mtimeMs: group.image.mtimeMs, size: group.image.size, ext: group.image.ext } : undefined,
    video: group.video ? { path: group.video.path, mtimeMs: group.video.mtimeMs, size: group.video.size, ext: group.video.ext } : undefined,
    previewPath,
    previewSource,
    meta: {},
    stars: marks?.stars ?? 0,
    del: marks?.del ?? false,
    focusHint: null,
  };
}
