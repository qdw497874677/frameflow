/** 照片记录 → 磁盘文件的纯映射。 */

import type { PhotoRecord } from '../photo.ts';

export type FileVariant = 'jpeg' | 'raw' | 'video' | 'auto';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
};

/** 把记录解成磁盘上的绝对路径（`variant` 决定要 RAW 还是 JPEG） */
export function fileOf(rec: PhotoRecord, variant: FileVariant): { path: string; name: string; mime: string } | null {
  const pick = variant === 'raw' ? rec.raw : variant === 'jpeg' ? rec.jpeg : variant === 'video' ? rec.video : (rec.jpeg ?? rec.raw ?? rec.video);
  if (!pick) return null;
  return { path: pick.path, name: `${rec.displayName}${pick.ext}`, mime: MIME[pick.ext.toLowerCase()] ?? 'application/octet-stream' };
}

/** 照片旁 XMP 的落点：`_DSC1042.xmp`（Adobe 规范的 stem 式命名） */
export function sidecarOf(rec: PhotoRecord): string | null {
  const src = rec.raw ?? rec.jpeg;
  if (!src) return null;
  return `${src.path.slice(0, src.path.length - src.ext.length)}.xmp`;
}
