/**
 * grade：滤镜设置阶段。选择集确认后建一个任务，主人逐张过一遍风格，「完成阶段」时全尺寸导出。
 *
 *  1. `plan`：选择集展开成 items 快照；视频直接 skipped（MVP 只调照片）。
 *  2. `apply`：任务进 running，停在这里等主人操作 —— items 保持 planned，settle 不会提前收尾。
 *  3. 操作（`POST /jobs/{id}/actions/{name}`）：
 *     - `set`：改一张的风格 / 强度 / 不套用、标过目、或恢复任务默认（写在 item.grade）；
 *     - `defaults`：改任务默认风格与强度（写在 params）；
 *     - `complete`：按「任务默认 + 逐张覆盖」逐张渲染、写成品目录，item 记 done / failed，任务收尾。
 *
 * 原片永远不动；单张失败不拖累其他，全部失败才算任务失败。
 */

import { JobError, type GradeItemState, type Job, type JobItem, type JobProblem } from '../../domain/jobs/job.ts';
import { lutEffect, type Effect } from '../../domain/grading/effects.ts';
import { DEFAULT_STRENGTH, exportName, isValidStrength, resolveRecipe, type Recipe } from '../../domain/grading/recipe.ts';
import type { GradingPorts } from '../grading/ports.ts';
import type { JobContext, JobDraft, JobHandler, JobOutcome, JobSink } from './registry.ts';

function defaultsOf(params: Record<string, unknown>): Recipe {
  const look = typeof params['look'] === 'string' ? params['look'] : null;
  const strength = isValidStrength(params['strength']) ? params['strength'] : DEFAULT_STRENGTH;
  return { look, strength };
}

function ports(ctx: JobContext): GradingPorts {
  if (!ctx.grading) throw new Error('滤镜阶段没接上风格 / 渲染 / 导出端口');
  return ctx.grading;
}

function lookProblems(ctx: JobContext, field: string, look: unknown, allowNull: boolean): JobProblem[] {
  if (look === null && allowNull) return [];
  const known = ctx.grading?.looks.list().map((l) => l.id) ?? [];
  if (typeof look !== 'string' || !known.includes(look)) {
    return [{ field, message: `要选一个内置风格：${known.join(' / ') || '（一个都没有）'}` }];
  }
  return [];
}

function validate(draft: JobDraft, ctx: JobContext): JobProblem[] {
  if (!ctx.grading) return [{ field: 'kind', message: '这个服务没接上滤镜端口，建不了 grade 任务' }];
  const problems = lookProblems(ctx, 'params.look', draft.params['look'], false);
  if (draft.params['strength'] !== undefined && !isValidStrength(draft.params['strength'])) {
    problems.push({ field: 'params.strength', message: '强度是 0–1 的数' });
  }
  if (!ctx.lib.select(draft.selection).some((r) => r.kind !== 'video')) {
    problems.push({ field: 'selection', message: '这个选择集里没有照片（视频不调色）' });
  }
  return problems;
}

function plan(draft: JobDraft, ctx: JobContext): JobItem[] {
  return ctx.lib.select(draft.selection).map((rec) =>
    rec.kind === 'video'
      ? { id: rec.id, displayName: rec.displayName, status: 'skipped' as const, note: '视频不调色' }
      : { id: rec.id, displayName: rec.displayName, status: 'planned' as const },
  );
}

function apply(job: Job, _ctx: JobContext, sink: JobSink): JobOutcome {
  const { look, strength } = defaultsOf(job.params ?? {});
  const n = job.items.filter((i) => i.status === 'planned').length;
  sink.event({ type: 'note', note: `滤镜设置开始：${n} 张，默认 ${look} · ${Math.round(strength * 100)}%` });
  return { state: 'running' };
}

function invalid(message: string, field = 'body'): never {
  throw new JobError('invalid', message, [{ field, message }]);
}

function editable(job: Job, photoId: unknown): JobItem {
  const item = job.items.find((i) => i.id === photoId);
  if (!item) invalid(`这张照片不在这个任务里：${String(photoId)}`, 'photoId');
  if (item.status !== 'planned') invalid(`这张已经是 ${item.status}，不能再改`, 'photoId');
  return item;
}

/** set：{ photoId, look?: string|null, strength?: number, reviewed?: boolean, reset?: boolean } */
function set(job: Job, body: Record<string, unknown>, ctx: JobContext, sink: JobSink): JobOutcome {
  const item = editable(job, body['photoId']);
  if (body['look'] !== undefined) {
    const p = lookProblems(ctx, 'look', body['look'], true);
    if (p.length) invalid(p[0]!.message, 'look');
  }
  if (body['strength'] !== undefined && !isValidStrength(body['strength'])) invalid('强度是 0–1 的数', 'strength');
  const prev: GradeItemState = body['reset'] === true ? {} : { ...(item.grade ?? {}) };
  if (body['look'] !== undefined) prev.look = body['look'] as string | null;
  if (body['strength'] !== undefined) prev.strength = body['strength'] as number;
  // 过目是显式动作（「通过」/ Enter 带 reviewed:true）；只改风格/强度不算看过
  if (body['reviewed'] === true) prev.reviewedAt = new Date().toISOString();
  else if (body['reviewed'] === false) prev.reviewedAt = null;
  sink.item(item.id, { grade: prev });
  return {};
}

/** defaults：{ look?: string, strength?: number } —— 改任务默认，没覆盖的照片都跟着变 */
function defaults(job: Job, body: Record<string, unknown>, ctx: JobContext, sink: JobSink): JobOutcome {
  const next = { ...job.params };
  if (body['look'] !== undefined) {
    const p = lookProblems(ctx, 'look', body['look'], false);
    if (p.length) invalid(p[0]!.message, 'look');
    next['look'] = body['look'];
  }
  if (body['strength'] !== undefined) {
    if (!isValidStrength(body['strength'])) invalid('强度是 0–1 的数', 'strength');
    next['strength'] = body['strength'];
  }
  sink.patch({ params: next });
  return {};
}

async function complete(job: Job, _body: Record<string, unknown>, ctx: JobContext, sink: JobSink): Promise<JobOutcome> {
  const { looks, renderer, exports } = ports(ctx);
  const base = defaultsOf(job.params ?? {});
  const todo = job.items.filter((i) => i.status === 'planned');
  sink.event({ type: 'note', note: `完成阶段：开始导出 ${todo.length} 张` });
  let ok = 0;
  for (const item of todo) {
    const recipe = resolveRecipe(base, item.grade);
    try {
      const effects: Effect[] = [];
      if (recipe.look) {
        const lut = await looks.load(recipe.look);
        if (!lut) throw new Error(`风格文件不见了：${recipe.look}`);
        effects.push(lutEffect(lut, recipe.strength));
      }
      const data = await renderer.render(item.id, effects);
      const name = exportName(item.displayName ?? item.id, recipe.look);
      const out = await exports.write(job.id, name, data);
      sink.item(item.id, { status: 'done', to: name, note: recipe.look ? `${recipe.look} · ${Math.round(recipe.strength * 100)}%` : '不套用', at: new Date().toISOString() });
      sink.event({ type: 'applied', photoId: item.id, to: name, note: `${out.bytes} 字节` });
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sink.item(item.id, { status: 'failed', note: msg, at: new Date().toISOString() });
      sink.event({ type: 'failed', photoId: item.id, note: msg });
    }
  }
  if (todo.length && ok === 0) return { state: 'failed', error: '全部导出失败' };
  sink.artifact({ kind: 'dir', path: exports.locate(job.id) });
  return { state: 'done', note: `导出完成：成功 ${ok}，失败 ${todo.length - ok}` };
}

export const grade: JobHandler = {
  kind: 'grade',
  label: '滤镜设置：逐张选胶片风格，完成后全尺寸导出',
  params: {
    look: { type: 'string', required: true, description: '默认风格 id（见 GET /looks）' },
    strength: { type: 'number', minimum: 0, maximum: 1, default: DEFAULT_STRENGTH, description: '默认强度' },
  },
  sideEffect: 'file',
  undoable: false,
  needsNetwork: false,
  validate,
  plan,
  apply,
  actions: { set, defaults, complete },
};
