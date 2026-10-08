/** 体积、时间这类展示用的格式化（UI 层共用） */

/** 镜头型号：EXIF 里没镜头时 exiftool 会给 `----` 这类占位符，别把它当型号显示 */
export function lensLabel(lens: string | null | undefined): string {
  const v = lens?.trim();
  return !v || /^[-–—\s]+$/.test(v) ? '' : v;
}

export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 紧凑本地时间：`MM-DD HH:mm`（列表里省宽度用；ISO 串是 UTC，不能直接截字符） */
export function formatShortTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const sec = withSeconds ? `:${p(d.getSeconds())}` : '';
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${sec}`;
}
