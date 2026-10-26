/**
 * grade：滤镜设置阶段。选择集确认后建一个任务，主人逐张过一遍风格，「完成阶段」时全尺寸导出。
 *
 *  1. `plan`：选择集展开成 items 快照；视频直接 skipped（MVP 只调照片）。
 *  2. `apply`：任务进 running，停在这里等主人操作 —— items 保持 planned，settle 不会提前收尾。
 *  3. 操作（`POST /jobs/{id}/actions/{name}`）：
 *     - `set`：改一张的风格 / 强度 / 不套用、标过目、或恢复任务默认（写在 item.grade）；
 *     - `defaults`：改任务默认风格与强度（写在 params）；
 *     - `complete`：只受理 —— 锁定配方（`phase: exporting`）立刻返回（HTTP 202）；
 *  4. `background`（任务层后台队列跑，重启续跑）：按「任务默认 + 逐张覆盖」限并发逐张渲染、写成品目录，
 *     单张失败重试一次，item 记 done / failed，任务收尾。
 *
 * 原片永远不动；单张失败不拖累其他，全部失败才算任务失败。
 */

import { JobError, type GradeItemState, type Job, type JobItem, type JobProblem } from '../../domain/jobs/job.ts';
import { lutEffect, type Effect } from '../../domain/grading/effects.ts';
import { DEFAULT_STRENGTH, exportName, isValidStrength, resolveRecipe, type Recipe } from '../../domain/grading/recipe.ts';
import type { GradingPorts } from '../grading/ports.ts';
import type { BackgroundSignal, JobContext, JobDraft, JobHandler, JobOutcome, JobSink } from './registry.ts';

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
  if (draft.params['keepGps'] !== undefined && typeof draft.params['keepGps'] !== 'boolean') {
    problems.push({ field: 'params.keepGps', message: 'keepGps 是布尔值' });
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
  notExporting(job);
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

/** defaults：{ look?: string, strength?: number, keepGps?: boolean } —— 改任务默认，没覆盖的照片都跟着变 */
function defaults(job: Job, body: Record<string, unknown>, ctx: JobContext, sink: JobSink): JobOutcome {
  notExporting(job);
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
  if (body['keepGps'] !== undefined) {
    if (typeof body['keepGps'] !== 'boolean') invalid('keepGps 是布尔值', 'keepGps');
    next['keepGps'] = body['keepGps'];
  }
  sink.patch({ params: next });
  return {};
}

/** 改动类操作在后台导出期间一律拒收：成品按受理那一刻的配方出，不能边导边改 */
function notExporting(job: Job): void {
  if (job.phase === 'exporting') throw new JobError('conflict', '正在后台导出，配方已锁定');
}

/**
 * complete：只受理 —— 锁定配方（phase=exporting）后立刻返回，渲染交给 `background`（HTTP 202）。
 * 照片多、单张几秒，同步跑会把请求拖到超时。
 */
function complete(job: Job, _body: Record<string, unknown>, ctx: JobContext, sink: JobSink): JobOutcome {
  ports(ctx);
  notExporting(job);
  const todo = job.items.filter((i) => i.status === 'planned').length;
  sink.patch({ phase: 'exporting' });
  sink.event({ type: 'note', note: `完成阶段：受理，后台导出 ${todo} 张` });
  return { background: true };
}

/** 单张失败先重试几次（网络盘偶发读失败、内存抖动）；还不行才记 failed */
const ATTEMPTS = 2;

/** 最多 limit 个并发跑完 list（不引第三方：一个游标 + limit 个 worker） */
async function eachLimited<T>(list: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < list.length; i = next++) await fn(list[i]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
}

/**
 * 后台导出：按「任务默认 + 逐张覆盖」逐张全尺寸渲染、写成品目录，item 记 done / failed。
 * 可重入（重启续跑）：只做还 planned 的；成品按文件名覆盖写，半截的那张重做即可。
 */
async function exportAll(job: Job, ctx: JobContext, sink: JobSink, signal: BackgroundSignal): Promise<JobOutcome> {
  const { looks, renderer, exports, concurrency, metadata } = ports(ctx);
  const keepGps = job.params?.['keepGps'] === true;
  const base = defaultsOf(job.params ?? {});
  const todo = job.items.filter((i) => i.status === 'planned');
  const renderOne = async (item: JobItem, recipe: Recipe): Promise<{ name: string; bytes: number }> => {
    const effects: Effect[] = [];
    if (recipe.look) {
      const lut = await looks.load(recipe.look);
      if (!lut) throw new Error(`风格文件不见了：${recipe.look}`);
      effects.push(lutEffect(lut, recipe.strength));
    }
    const data = await renderer.render(item.id, effects);
    const name = exportName(item.displayName ?? item.id, recipe.look);
    const out = await exports.write(job.id, name, data);
    await metadata?.carry(item.id, out.path, { keepGps });
    return { name, bytes: out.bytes };
  };
  let done = 0;
  await eachLimited(todo, concurrency ?? 2, async (item) => {
    if (signal.cancelled()) return;
    const recipe = resolveRecipe(base, item.grade);
    let lastError = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const out = await renderOne(item, recipe);
        sink.item(item.id, { status: 'done', to: out.name, note: recipe.look ? `${recipe.look} · ${Math.round(recipe.strength * 100)}%` : '不套用', at: new Date().toISOString() });
        sink.event({ type: 'applied', photoId: item.id, to: out.name, note: `${out.bytes} 字节${attempt > 1 ? `（第 ${attempt} 次成功）` : ''}` });
        done++;
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (signal.cancelled()) return;
      }
    }
    sink.item(item.id, { status: 'failed', note: lastError, at: new Date().toISOString() });
    sink.event({ type: 'failed', photoId: item.id, note: `${lastError}（重试 ${ATTEMPTS - 1} 次仍失败）` });
  });
  if (signal.cancelled()) return {};
  // 续跑时上一轮已有终态的也算进来
  const ok = job.items.filter((i) => i.status === 'done').length + done;
  const failed = job.items.filter((i) => i.status === 'failed').length + todo.length - done;
  if (ok + failed > 0 && ok === 0) return { state: 'failed', error: '全部导出失败' };
  sink.artifact({ kind: 'dir', path: exports.locate(job.id) });
  return { state: 'done', note: `导出完成：成功 ${ok}，失败 ${failed}` };
}

export const grade: JobHandler = {
  kind: 'grade',
  label: '滤镜设置：逐张选胶片风格，完成后全尺寸导出',
  params: {
    look: { type: 'string', required: true, description: '默认风格 id（见 GET /looks）' },
    strength: { type: 'number', minimum: 0, maximum: 1, default: DEFAULT_STRENGTH, description: '默认强度' },
    keepGps: { type: 'boolean', default: false, description: '成品保留 GPS（缺省剥掉；拍摄时间/相机/镜头/作者版权总是保留）' },
  },
  sideEffect: 'file',
  undoable: false,
  needsNetwork: false,
  validate,
  plan,
  apply,
  actions: { set, defaults, complete },
  background: exportAll,
};
