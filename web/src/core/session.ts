import type { Mark, Selection, ViewMode } from './types';

export interface Position { photoId?: string; mode: ViewMode; selection: Selection }
export interface LocalSession {
  lastDir?: string;
  positions: Record<string, Position>;
  seen: Record<string, boolean>;
  seenProjects: Record<string, string>;
  pending: Record<string, Mark>;
}
const KEY = 'artworks:cull-session:v1';
export function readSession(): LocalSession {
  const empty: LocalSession = { positions: {}, seen: {}, seenProjects: {}, pending: {} };
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!data || typeof data !== 'object') return empty;
    const entries = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
    for (const [id, value] of entries(data.seen)) if (value === true) empty.seen[id] = true;
    for (const [id, value] of entries(data.seenProjects)) if (typeof value === 'string') empty.seenProjects[id] = value;
    for (const [id, value] of entries(data.pending)) {
      if (value && typeof value.stars === 'number' && value.stars >= 0 && value.stars <= 5 && typeof value.del === 'boolean') empty.pending[id] = { stars: value.stars, del: value.del };
    }
    for (const [dir, value] of entries(data.positions)) {
      if (dir.startsWith('/') && value && (value.mode === 'a' || value.mode === 'c')) {
        empty.positions[dir] = { mode: value.mode, photoId: typeof value.photoId === 'string' ? value.photoId : undefined, selection: value.selection && typeof value.selection === 'object' ? value.selection : {} };
      }
    }
    if (typeof data.lastDir === 'string') empty.lastDir = data.lastDir;
  } catch { /* 隐私模式或损坏数据不阻止挑片 */ }
  return empty;
}
export function writeSession(session: LocalSession): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(session)); return true; }
  catch { return false; }
}
