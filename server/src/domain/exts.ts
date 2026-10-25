/** 扩展名分类（票 001）＋ NAS 上必须忽略的目录名。 */

/** 相机原始格式。注意：`.tif/.tiff` 不在这里 —— 它们更可能是可直读的图像。 */
export const RAW_EXTS = new Set([
  '.arw', '.srf', '.sr2', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.raf', '.dng',
  '.orf', '.rw2', '.raw', '.pef', '.srw', '.rwl', '.iiq', '.3fr', '.fff', '.x3f',
  '.mrw', '.erf', '.kdc', '.dcr', '.mef',
]);

/** 可直读的图像格式：配对里的「JPEG 侧」，也是预览的首选来源。 */
export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.heic', '.heif', '.avif', '.webp', '.tif', '.tiff',
]);

export const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.mts', '.m2ts', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.3gp',
]);

/** 影子文件：跟随主文件进出回收站，不单独成对（票 001 / 票 003 的 pair 定义）。 */
export const SIDECAR_EXTS = new Set(['.xmp', '.aae', '.thm', '.lrv', '.dop', '.pp3', '.on1', '.cos']);

/**
 * 扫描时永远跳过的目录名（不区分大小写）。
 * `@eaDir`/`#recycle`/`@Recycle` 是 NAS 的缩略图与回收站目录 —— 库在 NAS 上，必须无视它们，
 * 否则会把索引到别人的缩略图、甚至把用户的回收站当素材扫进来。
 */
export const DEFAULT_IGNORE_DIRS = [
  '.artworks', '.trash', '.git', '.svn', 'node_modules',
  '@eaDir', '#recycle', '@Recycle', '$RECYCLE.BIN', 'System Volume Information',
  '.thumbnails', '.cache', '.DS_Store',
];

/**
 * 系统/软件落下的元数据文件：扩展名看着像照片，其实不是 —— 必须点名跳过。
 * `._X.JPG`（macOS AppleDouble）最坑：不跳的话每张照片旁边都多出一张 11 字节的「幽灵照片」。
 */
export function isJunkFile(name: string): boolean {
  if (name.startsWith('.')) return true; // .DS_Store、._X.JPG、.hidden…
  const lower = name.toLowerCase();
  return lower === 'thumbs.db' || lower === 'ehthumbs.db' || lower === 'desktop.ini' || lower === 'picasa.ini';
}

export function classify(name: string): 'raw' | 'image' | 'video' | 'sidecar' | 'other' {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'other';
  const ext = name.slice(dot).toLowerCase();
  if (RAW_EXTS.has(ext)) return 'raw';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (SIDECAR_EXTS.has(ext)) return 'sidecar';
  return 'other';
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}
