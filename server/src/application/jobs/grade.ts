/**
 * grade：风格设置阶段。选择集确认后建一个任务，主人逐张过一遍风格，「完成阶段」时全尺寸导出。
 *
 *  1. `plan`：选择集展开成 items 快照；视频直接 skipped（MVP 只调照片）。
 *  2. `apply`：任务进 running，停在这里等主人操作 —— items 保持 planned，settle 不会提前收尾。
 *  3. 操作（`POST /jobs/{id}/actions/{name}`）：
 *     - `set`：改一张的风格 / 强度 / 不套用、标过目、或恢复任务默认（写在 item.grade）；
 *     - `defaults`：改任务默认配方 `recipe: { lookId, kind, params }`（写在 params；旧的 look/strength/film 仍收）；
 *     - `complete`：只受理 —— 锁定配方（`phase: exporting`）立刻返回（HTTP 202）；
 *  4. `background`（任务层后台队列跑，重启续跑）：按「任务默认 + 逐张覆盖」限并发逐张渲染、写成品目录，
 *     单张失败重试一次，item 记 done / failed，任务收尾。
 *
 * 原片永远不动；单张失败不拖累其他，全部失败才算任务失败。
 */

import { JobError, type GradeItemState, type Job, type JobItem, type JobProblem } from '../../domain/jobs/job.ts';
import { exportName, hasLegacyFields, isValidStrength, legacyRecipe, recipeFromParams, resolveRecipe, type LookRecipe } from '../../domain/grading/recipe.ts';
import { createHash } from 'node:crypto';
import { filmEffectProblems } from '../../domain/grading/film.ts';
import type { LookParams } from '../../domain/grading/look-kind.ts';
import type { GradingPorts } from '../grading/ports.ts';
import { LookKindRegistry, LutKind, type LookKind } from '../grading/look-kinds.ts';
import type { BackgroundSignal, JobContext, JobDraft, JobHandler, JobOutcome, JobSink } from './registry.ts';

/** 没指定种子时按照片 id 派生：同一张重导结果一致，不同照片颗粒不同 */
function seedFor(photoId: string): number {
  return createHash('sha256').update(photoId).digest().readUInt32LE(0);
}

function ports(ctx: JobContext): GradingPorts {
  if (!ctx.grading) throw new Error('风格阶段没接上风格 / 渲染 / 导出端口');
  return ctx.grading;
}

const fallbackKinds = new WeakMap<object, LookKindRegistry>();
/** 风格类型注册表；端口没给就把所有风格当 `lut` 类型（单测 / 只有内置 .cube 的部署） */
function kinds(ctx: JobContext): LookKindRegistry | null {
  const g = ctx.grading;
  if (!g) return null;
  if (g.kinds) return g.kinds;
  let r = fallbackKinds.get(g.looks);
  if (!r) { r = new LookKindRegistry([{ kind: new LutKind(g.looks), source: g.looks }]); fallbackKinds.set(g.looks, r); }
  return r;
}

function lookProblems(ctx: JobContext, field: string, look: unknown, allowNull: boolean): JobProblem[] {
  if (look === null && allowNull) return [];
  const known = kinds(ctx)?.entries().map((l) => l.id) ?? [];
  if (typeof look !== 'string' || !known.includes(look)) {
    return [{ field, message: `要选一个内置风格：${known.join(' / ') || '（一个都没有）'}` }];
  }
  return [];
}

/** 旧字段 film 的校验（兼容旧客户端）：{ grain, grainSeed, halation, halationRadiusMm, dirDiffusionUm, filmFormatMm } | null */
function filmProblems(v: unknown, field: string): JobProblem[] {
  if (v === null) return [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ field, message: 'film 是 { grain, grainSeed, halation, halationRadiusMm, dirDiffusionUm, filmFormatMm } 对象' }];
  return filmEffectProblems(v as Record<string, unknown>).map((message) => ({ field, message }));
}

/** 新字段 recipe 的校验：风格存在、kind 对得上、params 过该类型的模式 */
function recipeProblems(ctx: JobContext, field: string, r: unknown): JobProblem[] {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [{ field, message: 'recipe 是 { lookId, kind?, params? } 对象' }];
  const o = r as Record<string, unknown>;
  const p = lookProblems(ctx, `${field}.lookId`, o['lookId'], false);
  if (p.length) return p;
  const kind = kinds(ctx)!.kindOf(o['lookId'] as string)!;
  if (o['kind'] !== undefined && o['kind'] !== kind.kind) return [{ field: `${field}.kind`, message: `${String(o['lookId'])} 是 ${kind.kind} 类型的风格，不是 ${String(o['kind'])}` }];
  if (o['params'] === undefined) return [];
  return kind.validate(o['params']).map((message) => ({ field: `${field}.params`, message }));
}

/** 存进任务的配方（补上 kind；换了类型带不过去的参数丢掉） */
function settle(ctx: JobContext, lookId: string, params: unknown): LookRecipe {
  const kind = kinds(ctx)!.kindOf(lookId)!;
  return { lookId, kind: kind.kind, params: kind.normalize(params) };
}

/** 任务默认配方（新旧字段都认） */
function baseOf(job: Job): LookRecipe {
  return recipeFromParams(job.params ?? {});
}

function validate(draft: JobDraft, ctx: JobContext): JobProblem[] {
  if (!ctx.grading) return [{ field: 'kind', message: '这个服务没接上风格端口，建不了 grade 任务' }];
  const problems: JobProblem[] = [];
  if (draft.params['recipe'] !== undefined) {
    problems.push(...recipeProblems(ctx, 'params.recipe', draft.params['recipe']));
  } else {
    problems.push(...lookProblems(ctx, 'params.look', draft.params['look'], false));
    if (draft.params['strength'] !== undefined && !isValidStrength(draft.params['strength'])) {
      problems.push({ field: 'params.strength', message: '强度是 0–1 的数' });
    }
    if (draft.params['film'] !== undefined) problems.push(...filmProblems(draft.params['film'], 'params.film'));
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
      : { id: rec.id, displayName: rec.displayName, status: 'planned' as const, ...(rec.raw && !rec.jpeg ? { source: 'embedded_jpeg' as const } : {}) },
  );
}

/** 开跑时把旧字段折算成 recipe 存回去（任务参数只留一种写法） */
function apply(job: Job, ctx: JobContext, sink: JobSink): JobOutcome {
  const base = baseOf(job);
  if (base.lookId) {
    const { look: _l, strength: _s, film: _f, ...rest } = job.params ?? {};
    sink.patch({ params: { ...rest, recipe: settle(ctx, base.lookId, base.params) } });
  }
  const n = job.items.filter((i) => i.status === 'planned').length;
  const strength = typeof base.params['strength'] === 'number' ? base.params['strength'] : 1;
  sink.event({ type: 'note', note: `风格设置开始：${n} 张，默认 ${base.lookId} · ${Math.round(strength * 100)}%` });
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

/**
 * defaults：改任务默认，没覆盖的照片都跟着变。
 * 新写法 `{ recipe: { lookId?, params? }, keepGps? }`（params 整体替换）；
 * 旧写法 `{ look?, strength?, film?: FilmEffects | null, keepGps? }` 仍收，折算进 recipe。
 */
function defaults(job: Job, body: Record<string, unknown>, ctx: JobContext, sink: JobSink): JobOutcome {
  notExporting(job);
  const cur = baseOf(job);
  let lookId = cur.lookId;
  let params: Record<string, unknown> = { ...cur.params };
  let strict = false;
  if (body['recipe'] !== undefined) {
    const r = body['recipe'];
    if (!r || typeof r !== 'object' || Array.isArray(r)) invalid('recipe 是 { lookId?, params? } 对象', 'recipe');
    const o = r as Record<string, unknown>;
    if (o['lookId'] !== undefined) lookId = o['lookId'] as string;
    if (o['params'] !== undefined) { params = o['params'] as Record<string, unknown>; strict = true; }
    const p = recipeProblems(ctx, 'recipe', { lookId, ...(o['kind'] !== undefined ? { kind: o['kind'] } : {}), ...(strict ? { params } : {}) });
    if (p.length) invalid(p.map((x) => x.message).join('；'), p[0]!.field);
  } else if (hasLegacyFields(body)) {
    if (body['look'] !== undefined) {
      const p = lookProblems(ctx, 'look', body['look'], false);
      if (p.length) invalid(p[0]!.message, 'look');
      lookId = body['look'] as string;
    }
    if (body['strength'] !== undefined) {
      if (!isValidStrength(body['strength'])) invalid('强度是 0–1 的数', 'strength');
      params['strength'] = body['strength'];
    }
    if (body['film'] !== undefined) {
      const p = filmProblems(body['film'], 'film');
      if (p.length) invalid(p.map((x) => x.message).join('；'), 'film');
      for (const k of ['grain', 'grainSeed', 'halation', 'halationRadiusMm', 'dirDiffusionUm', 'filmFormatMm']) delete params[k];
      if (body['film'] !== null) Object.assign(params, legacyRecipe({ film: body['film'] }).params);
    }
  }
  const { look: _l, strength: _s, film: _f, ...next } = job.params ?? {};
  if (lookId) next['recipe'] = settle(ctx, lookId, params);
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

interface ItemRecipe { lookId: string | null; kind: LookKind | null; params: LookParams; strength: number }

/** 任务默认 + 逐张覆盖（换风格 / 改强度 / 不套用）→ 这张最终的风格、类型与参数 */
function itemRecipe(registry: LookKindRegistry, base: LookRecipe, override: GradeItemState | null | undefined): ItemRecipe {
  const strength0 = typeof base.params['strength'] === 'number' ? base.params['strength'] : 1;
  const r = resolveRecipe({ look: base.lookId, strength: strength0 }, override);
  const kind = r.look ? registry.kindOf(r.look) : null;
  const params = kind ? kind.normalize({ ...base.params, strength: r.strength }) : {};
  return { lookId: r.look, kind, params, strength: r.strength };
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
  const { renderer, exports, concurrency, metadata } = ports(ctx);
  const registry = kinds(ctx)!;
  const keepGps = job.params?.['keepGps'] === true;
  const base = baseOf(job);
  const todo = job.items.filter((i) => i.status === 'planned');
  const renderOne = async (item: JobItem, recipe: ItemRecipe): Promise<{ name: string; bytes: number }> => {
    const effects = recipe.kind && recipe.lookId ? await recipe.kind.effects(recipe.lookId, recipe.params, { seed: seedFor(item.id) }) : [];
    const data = await renderer.render(item.id, effects);
    const name = exportName(item.displayName ?? item.id, recipe.lookId);
    const out = await exports.write(job.id, name, data);
    await metadata?.carry(item.id, out.path, { keepGps });
    return { name, bytes: out.bytes };
  };
  let done = 0;
  await eachLimited(todo, concurrency ?? 2, async (item) => {
    if (signal.cancelled()) return;
    const recipe = itemRecipe(registry, base, item.grade);
    let lastError = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const out = await renderOne(item, recipe);
        sink.item(item.id, { status: 'done', to: out.name, note: recipe.lookId ? `${recipe.lookId} · ${Math.round(recipe.strength * 100)}%` : '不套用', at: new Date().toISOString() });
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
  label: '风格设置：逐张选风格，完成后全尺寸导出',
  params: {
    recipe: { type: 'object', description: '默认配方 { lookId, kind?, params? }：lookId 见 GET /looks，params 按该风格类型的参数模式（GET /look-kinds）' },
    look: { type: 'string', description: '旧写法（兼容）：默认风格 id；给了 recipe 就不用' },
    strength: { type: 'number', minimum: 0, maximum: 1, default: 1, description: '旧写法（兼容）：默认强度 = recipe.params.strength' },
    film: { type: 'object', description: '旧写法（兼容）：胶片整帧效果，折算进 recipe.params（grain / grainSeed / halation / halationRadiusMm / dirDiffusionUm / filmFormatMm）' },
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
