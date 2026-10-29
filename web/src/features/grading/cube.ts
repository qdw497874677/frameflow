/** .cube 解析（与服务端 domain/grading/lut.ts 同一约定：红最快、蓝最慢）+ 阶段里的纯计算 */
import type { FilmEffects, Job, JobItem, LookKindSchema, LookParams, LookRecipe } from '../../core/types.ts';

export interface Lut {
  size: number;
  table: Float32Array;
}

export function parseCube(text: string): Lut {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (/^[A-Za-z]/.test(line)) continue;
    for (const part of line.split(/\s+/)) values.push(Number(part));
  }
  if (!Number.isInteger(size) || size < 2 || values.length !== size ** 3 * 3) throw new Error('不是合法的 .cube');
  return { size, table: Float32Array.from(values) };
}

export interface Recipe {
  look: string | null;
  strength: number;
}

const LEGACY_FILM_KEYS = ['grain', 'grainSeed', 'halation', 'halationRadiusMm', 'dirDiffusionUm', 'filmFormatMm'] as const;

/** 任务默认配方：新字段 params.recipe，没有就从旧的 look / strength / film 折算（与服务端 recipeFromParams 一致） */
export function jobRecipe(job: Pick<Job, 'params'>): LookRecipe {
  const r = job.params?.recipe as Partial<LookRecipe> | undefined;
  if (r && typeof r === 'object' && typeof r.lookId === 'string') return { lookId: r.lookId, ...(r.kind ? { kind: r.kind } : {}), params: { ...(r.params ?? {}) } };
  const params: LookParams = {};
  if (typeof job.params?.strength === 'number') params.strength = job.params.strength;
  const f = job.params?.film;
  if (f && typeof f === 'object') for (const k of LEGACY_FILM_KEYS) { const v = (f as Record<string, unknown>)[k]; if (typeof v === 'number') params[k] = v; }
  return { lookId: typeof job.params?.look === 'string' ? job.params.look : null, params };
}

export function jobDefaults(job: Pick<Job, 'params'>): Recipe {
  const r = jobRecipe(job);
  const s = r.params.strength;
  return { look: r.lookId, strength: typeof s === 'number' && s >= 0 && s <= 1 ? s : 1 };
}

/** 参数的有效值：给了用给的，没给用模式缺省 */
export function paramValue(schema: LookKindSchema, params: LookParams, key: string): number | string | boolean | undefined {
  const d = schema.params.find((p) => p.key === key);
  if (!d) return undefined;
  return params[key] ?? d.default;
}

/** 只保留该类型认得的参数（换类型时带不过去的丢掉） */
export function paramsForKind(schema: LookKindSchema | undefined, params: LookParams): LookParams {
  if (!schema) return {};
  const out: LookParams = {};
  for (const d of schema.params) if (params[d.key] !== undefined) out[d.key] = params[d.key]!;
  return out;
}

/** 影响 LUT 的参数（preview: lut，强度除外 —— 强度在着色器里混）→ .cube 查询串；空 = 缺省 LUT */
export function cubeQuery(schema: LookKindSchema | undefined, params: LookParams): string {
  if (!schema) return '';
  const q = new URLSearchParams();
  for (const d of schema.params) {
    if (d.preview !== 'lut' || d.key === 'strength' || params[d.key] === undefined || params[d.key] === d.default) continue;
    q.set(d.key, String(params[d.key]));
  }
  return q.toString();
}

/** 设一项：等于缺省就删掉（配方只存改过的项） */
export function patchParams(schema: LookKindSchema, params: LookParams, key: string, value: number | string | boolean | null): LookParams {
  const next: LookParams = { ...params };
  const d = schema.params.find((p) => p.key === key);
  if (value === null || (typeof value === 'number' && Number.isNaN(value)) || (d && d.default === value)) delete next[key];
  else next[key] = value;
  return next;
}

/** 边框画布（与服务端 borderLayout 同一算法）：先四周等宽加边，再沿短缺方向补到目标画幅 */
export function borderLayout(w: number, h: number, spec: { width: number; ratio: string }): { width: number; height: number; x: number; y: number } {
  const b = Math.round(Math.min(w, h) * Math.max(0, spec.width));
  let W = w + 2 * b, H = h + 2 * b;
  const m = /^(\d+):(\d+)$/.exec(spec.ratio);
  if (m) {
    const long = Math.max(+m[1]!, +m[2]!), short = Math.min(+m[1]!, +m[2]!);
    const r = W >= H ? long / short : short / long;
    if (W / H > r) H = Math.round(W / r);
    else W = Math.round(H * r);
  }
  return { width: W, height: H, x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2) };
}

/** 任务默认 + 逐张覆盖 → 这张实际套什么（与服务端 resolveRecipe 一致） */
export function recipeOf(job: Pick<Job, 'params'>, item: Pick<JobItem, 'grade'>): Recipe {
  const d = jobDefaults(job);
  const o = item.grade;
  return { look: o && o.look !== undefined ? o.look : d.look, strength: o?.strength ?? d.strength };
}

export function isOverridden(item: Pick<JobItem, 'grade'>): boolean {
  return item.grade?.look !== undefined || item.grade?.strength !== undefined;
}

/** 已过目 x / N（只算还要导出的照片；视频等 skipped 不计） */
export function reviewProgress(job: Pick<Job, 'items'>): { reviewed: number; total: number } {
  const relevant = job.items.filter((i) => i.status !== 'skipped');
  return { reviewed: relevant.filter((i) => i.status !== 'planned' || Boolean(i.grade?.reviewedAt)).length, total: relevant.length };
}

/** 阶段只在任务 running / interrupted 时可改；收场后（done/failed/cancelled）只读看结果 */
export function isStageEditable(job: Pick<Job, 'state' | 'phase'>): boolean {
  return (job.state === 'running' || job.state === 'interrupted') && !job.phase;
}

/** 已按「完成并导出」、后台还在渲染（服务端 phase=exporting；中断后重启会续跑） */
export function isExporting(job: Pick<Job, 'state' | 'phase'>): boolean {
  return job.phase === 'exporting' && (job.state === 'running' || job.state === 'interrupted');
}

/** 只有 RAW 的照片：预览与成品都用机内内嵌 JPEG（不做 RAW 解码） */
export const isRawEmbedded = (item: Pick<JobItem, 'source'>) => item.source === 'embedded_jpeg';

/** 每张在导出中的状态文字（卡片右下角） */
export function itemExportLabel(job: Pick<Job, 'state' | 'phase'>, item: Pick<JobItem, 'status' | 'grade'>): string {
  if (item.status === 'done') return '已导出';
  if (item.status === 'failed') return '失败';
  if (isExporting(job)) return '导出中…';
  return item.grade?.reviewedAt ? '✓' : '';
}

/** 收场后的结果计数：导出成功 / 失败（skipped 不计） */
export function exportSummary(job: Pick<Job, 'items'>): { done: number; failed: number } {
  return { done: job.items.filter((i) => i.status === 'done').length, failed: job.items.filter((i) => i.status === 'failed').length };
}

export const clampStrength = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;

/** 风格条循环：[ / ]；null（原图）排在最前 */
export function cycleLook(ids: string[], current: string | null, step: 1 | -1): string | null {
  const ring: (string | null)[] = [null, ...ids];
  const i = Math.max(0, ring.indexOf(current));
  return ring[(i + step + ring.length) % ring.length] ?? null;
}

/** 任务的胶片整帧效果（params.film）；不是对象就当没开 */
export function jobFilm(job: Pick<Job, 'params'>): FilmEffects {
  const p = jobRecipe(job).params;
  const out: Record<string, number> = {};
  for (const k of LEGACY_FILM_KEYS) if (typeof p[k] === 'number') out[k] = p[k] as number;
  return out as FilmEffects;
}

/** 与服务端 hasFilmEffects 一致：颗粒 / 光晕 / DIR 任一 > 0 才走整帧渲染 */
export function filmEffectsOn(f: FilmEffects): boolean {
  return (f.grain ?? 0) > 0 || (f.halation ?? 0) > 0 || (f.dirDiffusionUm ?? 0) > 0;
}

/** 改一项：0 / 空值就删掉这项，全删光发 null（清掉 params.film） */
export function patchFilm(f: FilmEffects, key: keyof FilmEffects, value: number | null): FilmEffects | null {
  const next: FilmEffects = { ...f };
  if (value === null || Number.isNaN(value)) delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : null;
}
