/**
 * 选择集（Selection）的求值 —— 与前端 `web/src/core/selection.ts` 同一套语义。
 *
 * 规范在 `contracts/selection.md`（那份是权威）。前端、后端、将来的任务 manifest 都按它求值：
 * 任务是「选择集 + 操作 + 参数」，选择集要能进 URL、进任务、进日志、被外部渠道复现。
 *
 * 与前端的一处差别：`by:` 词需要「这张照片最后一次标注变更是谁做的」，
 * 那是服务端的 `marks.jsonl` 才知道的事（前端只拿到自己的会话状态），所以这里接受一个解析器。
 */

import type { PhotoRecord } from './photo.ts';

export interface Selection {
  project?: string;
  where?: {
    kind?: 'photo' | 'video';
    stars?: { gte?: number; lte?: number; eq?: number };
    del?: boolean;
    marked?: boolean;
    folder?: string;
    camera?: string;
    taken?: { after?: string; before?: string };
    /** 最后一次标注变更的来源前缀：`me` / `link:飞书群` / `ai`（票 009 的 `by:` 词） */
    by?: string;
  };
  ids?: string[];
}

/** 解析最后变更来源：返回 null 表示这张照片从未被标注过 —— 不匹配任何 `by` 词。 */
export type LastByResolver = (photoId: string) => string | null;

export function matchesSelection(
  rec: PhotoRecord,
  sel?: Selection,
  lastBy?: LastByResolver,
): boolean {
  if (!sel) return true;
  if (sel.ids?.length && !sel.ids.includes(rec.id)) return false;

  // `project` = 根（项目）id：必须在 `where` 早退之前判断，否则只带 project 的选择集会卷进别的项目
  if (sel.project && rec.rootId !== sel.project) return false;

  const w = sel.where;
  if (!w) return true;

  if (w.kind && rec.kind !== w.kind) return false;
  if (w.del !== undefined && rec.del !== w.del) return false;
  if (w.marked !== undefined && (rec.stars > 0) !== w.marked) return false;

  const st = w.stars;
  if (st) {
    if (st.eq !== undefined && rec.stars !== st.eq) return false;
    if (st.gte !== undefined && rec.stars < st.gte) return false;
    if (st.lte !== undefined && rec.stars > st.lte) return false;
  }

  const dir = rec.relDir;
  if (w.folder && !dir.toLowerCase().includes(w.folder.toLowerCase())) return false;
  if (w.camera && !(rec.meta.camera ?? '').toLowerCase().includes(w.camera.toLowerCase())) return false;

  const day = (rec.meta.capturedAt ?? new Date(rec.raw?.mtimeMs ?? rec.jpeg?.mtimeMs ?? 0).toISOString()).slice(0, 10);
  if (w.taken?.after && day < w.taken.after) return false;
  if (w.taken?.before && day > w.taken.before) return false;

  if (w.by) {
    const last = lastBy?.(rec.id) ?? null;
    if (!last || !last.startsWith(w.by)) return false;
  }

  return true;
}

/** 紧凑字符串 → 选择集；认不出的词忽略（向前兼容）。 */
export function selectionFromQuery(q?: string | null): Selection {
  const sel: Selection = {};
  if (!q) return sel;

  const where: NonNullable<Selection['where']> = {};
  const ids: string[] = [];

  for (const raw of q.split(',')) {
    const term = raw.trim();
    if (!term) continue;

    let m = /^stars(>=|<=|=)(\d+)$/.exec(term);
    if (m) {
      const n = Number(m[2]);
      where.stars = { ...where.stars, [m[1] === '>=' ? 'gte' : m[1] === '<=' ? 'lte' : 'eq']: n };
      continue;
    }

    m = /^taken(>=|<=)(\d{4}-\d{2}-\d{2})$/.exec(term);
    if (m) {
      where.taken = { ...where.taken, [m[1] === '>=' ? 'after' : 'before']: m[2] };
      continue;
    }

    m = /^(kind|del|marked|folder|camera|project|ids|by):(.*)$/.exec(term);
    if (m) {
      const key = m[1];
      const val = safeDecode(m[2] ?? '');
      if (key === 'kind') where.kind = val === 'video' ? 'video' : 'photo';
      else if (key === 'del') where.del = val !== 'false';
      else if (key === 'marked') where.marked = val !== 'false';
      else if (key === 'folder') where.folder = val;
      else if (key === 'camera') where.camera = val;
      else if (key === 'project') sel.project = val;
      else if (key === 'ids') ids.push(...val.split('|').filter(Boolean));
      else if (key === 'by') where.by = val;
      continue;
    }

    if (term === 'del') where.del = true;
    else if (term === 'marked') where.marked = true;
  }

  if (Object.keys(where).length) sel.where = where;
  if (ids.length) sel.ids = ids;
  return sel;
}

export function selectionIsEmpty(sel?: Selection): boolean {
  if (!sel) return true;
  return !sel.project && !sel.ids?.length && Object.keys(sel.where ?? {}).length === 0;
}

/** 旧客户端的 `filter=starred|unmarked|...` 简写 → 选择集（`sel` 已经是新的正路）。 */
export function selectionFromLegacyFilter(filter?: string | null): Selection {
  switch (filter) {
    case 'starred':
      return { where: { marked: true } };
    case 'unmarked':
      return { where: { marked: false } };
    case 'trash':
      return { where: { del: true } };
    default:
      return {};
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
