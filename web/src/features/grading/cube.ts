/** .cube 解析（与服务端 domain/grading/lut.ts 同一约定：红最快、蓝最慢）+ 阶段里的纯计算 */
import type { Job, JobItem } from '../../core/types.ts';

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

export function jobDefaults(job: Pick<Job, 'params'>): Recipe {
  const look = typeof job.params?.look === 'string' ? job.params.look : null;
  const s = job.params?.strength;
  return { look, strength: typeof s === 'number' && s >= 0 && s <= 1 ? s : 1 };
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

export const clampStrength = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;

/** 风格条循环：[ / ]；null（原图）排在最前 */
export function cycleLook(ids: string[], current: string | null, step: 1 | -1): string | null {
  const ring: (string | null)[] = [null, ...ids];
  const i = Math.max(0, ring.indexOf(current));
  return ring[(i + step + ring.length) % ring.length] ?? null;
}
