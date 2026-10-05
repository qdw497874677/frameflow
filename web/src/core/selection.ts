import type { Photo, Selection } from './types';

/**
 * 选择集（Selection）：挑出「哪些照片」的谓词。
 *
 * 为什么不是 id 清单：任务是「选择集 + 操作 + 参数」，任务要能存盘、能进 URL、
 * 能发给后端、能在外部渠道里被复现（「我看到的也是这 37 张吗」）。
 * id 清单会过期，谓词不会。
 *
 * 两种表示，语义完全一样：
 *  - 对象形式（canonical）：task/job 的字段、后端存储用
 *  - 紧凑字符串形式：URL 与 GET 查询参数用，`?sel=stars>=3,marked,kind:photo`
 * 规范见 contracts/selection.md（后端按同一份规范实现求值）。
 */

/** 谓词求值：mock 现在用它，后端将实现同一套语义 */
export function matchesSelection(photo: Photo, sel?: Selection): boolean {
  if (!sel) return true;
  if (sel.ids?.length && !sel.ids.includes(photo.id)) return false;

  const w = sel.where;
  if (!w) return true;

  if (w.kind && photo.kind !== w.kind) return false;
  if (w.del !== undefined && photo.mark.del !== w.del) return false;
  if (w.marked !== undefined && (photo.mark.stars > 0) !== w.marked) return false;

  const st = w.stars;
  if (st) {
    if (st.eq !== undefined && photo.mark.stars !== st.eq) return false;
    if (st.gte !== undefined && photo.mark.stars < st.gte) return false;
    if (st.lte !== undefined && photo.mark.stars > st.lte) return false;
  }

  if (w.folder && !photo.dir.toLowerCase().includes(w.folder.toLowerCase())) return false;
  if (w.camera && !(photo.camera ?? '').toLowerCase().includes(w.camera.toLowerCase())) return false;

  const day = (photo.capturedAt ?? photo.mtime).slice(0, 10);
  if (w.taken?.after && day < w.taken.after) return false;
  if (w.taken?.before && day > w.taken.before) return false;

  return true;
}

export function selectionIsEmpty(sel?: Selection): boolean {
  if (!sel) return true;
  return !sel.project && !sel.ids?.length && Object.keys(sel.where ?? {}).length === 0;
}

const enc = encodeURIComponent;

/** 对象 → 紧凑字符串（值里的 `,` 与 `|` 会被转义，所以能安全按分隔符切） */
export function selectionToQuery(sel: Selection): string {
  const terms: string[] = [];
  const w = sel.where ?? {};

  if (sel.project) terms.push(`project:${enc(sel.project)}`);
  if (w.kind) terms.push(`kind:${w.kind}`);
  if (w.stars?.eq !== undefined) terms.push(`stars=${w.stars.eq}`);
  if (w.stars?.gte !== undefined) terms.push(`stars>=${w.stars.gte}`);
  if (w.stars?.lte !== undefined) terms.push(`stars<=${w.stars.lte}`);
  if (w.del !== undefined) terms.push(w.del ? 'del' : 'del:false');
  if (w.marked !== undefined) terms.push(w.marked ? 'marked' : 'marked:false');
  if (w.folder) terms.push(`folder:${enc(w.folder)}`);
  if (w.camera) terms.push(`camera:${enc(w.camera)}`);
  if (w.taken?.after) terms.push(`taken>=${w.taken.after}`);
  if (w.taken?.before) terms.push(`taken<=${w.taken.before}`);
  if (sel.ids?.length) terms.push(`ids:${sel.ids.map(enc).join('|')}`);

  return terms.join(',');
}

/** 紧凑字符串 → 对象；认不出的词忽略（向前兼容：将来加词不影响旧客户端） */
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

    m = /^(kind|del|marked|folder|camera|project|ids):(.*)$/.exec(term);
    if (m) {
      const key = m[1];
      const val = decodeURIComponent(m[2] ?? '');
      if (key === 'kind') where.kind = val === 'video' ? 'video' : 'photo';
      else if (key === 'del') where.del = val !== 'false';
      else if (key === 'marked') where.marked = val !== 'false';
      else if (key === 'folder') where.folder = val;
      else if (key === 'camera') where.camera = val;
      else if (key === 'project') sel.project = val;
      else if (key === 'ids') ids.push(...val.split('|').filter(Boolean));
      continue;
    }

    if (term === 'del') where.del = true;
    else if (term === 'marked') where.marked = true;
  }

  if (Object.keys(where).length) sel.where = where;
  if (ids.length) sel.ids = ids;
  return sel;
}

/** 一句话描述，给提示条与任务预览用 */
export function describeSelection(sel: Selection): string {
  const q = selectionToQuery(sel);
  return q || '全部照片';
}
