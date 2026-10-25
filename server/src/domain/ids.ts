/**
 * id 与虚拟路径。绝对路径不出进程：客户端只看到 `/根名/子目录/...` 这种虚拟路径。
 *
 * - 照片 id = base64url(`<rootId>\0<relStem>`)，可逆 → 不需要索引也能定位文件（索引可重建的前提）。
 * - 目录路径 = `/照片库/2026-冰岛/A7M4/照片/原始`；根自身 = `/照片库`。
 * - 顶层路径 `/` 表示「所有根」，只在列根目录时出现。
 */

const SEP = '\u0000';

export function encodePhotoId(rootId: string, relStem: string): string {
  return Buffer.from(`${rootId}${SEP}${relStem}`, 'utf8').toString('base64url');
}

export function decodePhotoId(id: string): { rootId: string; relStem: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const cut = raw.indexOf(SEP);
  if (cut <= 0 || cut === raw.length - 1) return null;
  return { rootId: raw.slice(0, cut), relStem: raw.slice(cut + 1) };
}

export function dirPath(rootId: string, relDir: string): string {
  const clean = relDir.split('/').filter(Boolean).join('/');
  return clean ? `/${rootId}/${clean}` : `/${rootId}`;
}

export function parseDirPath(dir: string): { rootId: string; relDir: string } | null {
  const parts = dir.split('/').filter(Boolean);
  const rootId = parts.shift();
  if (!rootId) return null;
  return { rootId, relDir: parts.join('/') };
}

/**
 * 给客户端看的虚拟文件路径（不泄露真实绝对路径）。
 * 文件名按**磁盘上的真实大小写**原样给出（`_1110316.RW2` 不能写成 `.rw2`）——
 * 客户端拿它拼下载/导出路径时必须对得上盘上的名字。
 */
export function virtualFilePath(dir: string, fileName: string): string {
  return `${dir}/${fileName}`;
}

/** 元数据缓存的键：真实路径 + mtime + size —— 三者任一变化就重算（票 001 的缓存键）。 */
export function fileSig(path: string, mtimeMs: number, size: number): string {
  return `${path}|${Math.floor(mtimeMs)}|${size}`;
}
