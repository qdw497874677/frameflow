/**
 * exiftool 封装（`exiftool-vendored`）。
 *
 * 只做两件事，都是票 001 里的必需品：
 *  1. 批量读元数据（相机 / 镜头 / 拍摄时间 / 尺寸 / 朝向）—— 一次进程、批量喂文件；
 *  2. 抽内嵌 JPEG（`JpgFromRaw` → `PreviewImage` → `ThumbnailImage` 依次尝试）—— RAW 没有外拍 JPEG 时的预览来源。
 *
 * 本机没有 `exiftool` 可执行文件，但有 perl：`exiftool-vendored` 自带 exiftool 的 .pl 发行版，够用。
 */

import { exiftool, type Tags } from 'exiftool-vendored';
import type { FileMeta } from '../../domain/photo.ts';

/** exiftool 的 ExifDateTime 有 `toDate()`（带时区），纯字符串日期走 Date 解析。 */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const anyVal = value as { toDate?: () => Date; toString: () => string };
  try {
    if (typeof anyVal.toDate === 'function') {
      const d = anyVal.toDate();
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const s = String(value);
    const d = new Date(s.includes('T') ? s : s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {
    return null;
  }
  return null;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s && s !== 'unknown' ? s : null;
}

function toMeta(t: Tags): FileMeta {
  const tags = t as unknown as Record<string, unknown>;
  const orientation = Number(tags['Orientation']);
  return {
    width: num(tags['ExifImageWidth']) ?? num(tags['ImageWidth']),
    height: num(tags['ExifImageHeight']) ?? num(tags['ImageHeight']),
    orientation: Number.isFinite(orientation) && orientation >= 1 && orientation <= 8 ? orientation : undefined,
    camera: str(tags['Model']) ?? str(tags['CameraModelName']),
    lens: str(tags['LensModel']) ?? str(tags['LensID']) ?? str(tags['Lens']),
    capturedAt: toIso(tags['DateTimeOriginal']) ?? toIso(tags['CreateDate']) ?? toIso(tags['ModifyDate']),
  };
}

/** 同时在跑的读任务数。exiftool-vendored 自己会在多个 exiftool 进程间排队，这里只是别一次塞进去一万个 promise。 */
const CONCURRENCY = 8;

/** 读一批文件的元数据；单个文件读不出来只是没有元数据，不能让整次扫描失败（网络共享上读到一半掉线是常事）。 */
export async function readMetas(
  paths: string[],
  onError?: (path: string, err: unknown) => void,
): Promise<Map<string, FileMeta>> {
  const out = new Map<string, FileMeta>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      const path = paths[i] as string;
      try {
        out.set(path, toMeta(await exiftool.read(path, { readArgs: ['-fast'] })));
      } catch (err) {
        onError?.(path, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
  return out;
}

/** 内嵌 JPEG 的三个候选标签：越大越靠前（`JpgFromRaw` 常是全尺寸的，`ThumbnailImage` 最小）。 */
const PREVIEW_TAGS = ['JpgFromRaw', 'PreviewImage', 'ThumbnailImage'] as const;

/** 抽内嵌 JPEG；三个标签依次退让，全抽不出返 null，交给上层降级（LibRaw / 占位图）。 */
export async function extractEmbeddedJpeg(path: string): Promise<Buffer | null> {
  for (const tag of PREVIEW_TAGS) {
    try {
      const buf = await exiftool.extractBinaryTagToBuffer(tag, path);
      if (buf.length > 1024) return buf;
    } catch {
      // 这个文件没有这个标签 —— 试下一个
    }
  }
  return null;
}

export async function endExif(): Promise<void> {
  await exiftool.end();
}
