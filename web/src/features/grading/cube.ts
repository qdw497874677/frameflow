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
