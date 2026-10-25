/** 游标分页：游标 = 上一页最后一张的 id（base64url）。 */

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export interface Page<T> {
  page: T[];
  /** 本页之后是否还有 */
  more: boolean;
}

export function pageAfter<T extends { id: string }>(list: T[], cursor: string | null | undefined, limit?: number): Page<T> {
  const size = Math.max(1, Math.min(1000, limit ?? 200));
  const decoded = cursor ? decodeCursor(cursor) : null;
  const idx = decoded ? list.findIndex((r) => r.id === decoded) : -1;
  const start = idx + 1;
  const page = list.slice(start, start + size);
  return { page, more: start + page.length < list.length };
}
