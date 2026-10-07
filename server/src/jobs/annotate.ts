/**
 * annotate：把一批照片派给某个人批注（把选择集推成一张清单），批注结果回流直接落盘。
 *
 * 一次 annotate 任务走三步：
 *  1. `plan`：把选择集**展开成 items 快照**（一张照片 = 一项，RAW+JPEG 是同一项）。
 *     快照是刻意的：任务的粒度是「这批照片」，之后照片被移走/改了条件都不影响这张清单。
 *  2. `apply`：签发**任务范围 token**（载荷 `annotate|<jobId>|<别名>|<exp>`，30 天），
 *     把批次链接写进 artifacts（`kind: 'url'`，形如 `/j?t=…`；批注页以后再做），任务进 `running` 等回流。
 *     这一步**不等**对方回复（人可能明天才看），所以 `apply` 里不写任何等待逻辑。
 *  3. 回流：`POST /jobs/{id}/inbound`（api/server.ts 的鉴权闸认这条路上的 `?t=` 范围 token，免登录）。
 *     `by` 由 token 里的别名推成 `link:<别名>`，写标注走 `lib.applyMarks`（落 marks.jsonl：from→to + channel + jobId）。
 *     全部 items 有终态后任务 `done`（收尾在 jobs/service.ts）。
 *
 * `undo`：用 marks.jsonl 里**本任务写下的 from** 值把标注回滚（最早的 from 才算「任务前的样子」），
 * 回滚本身也记 jobId，所以 `GET /marks/history?jobId=` 能看到完整的「改了什么 + 又退回来了」。
 */

import type { Job, JobItem, JobProblem } from '../core/jobs.ts';
import type { MarkInput } from '../core/marks.ts';
import { channelById, channelIds } from './channels.ts';
import type { InboundOutcome, InboundWrite, JobContext, JobDraft, JobHandler, JobOutcome, JobSink } from './registry.ts';

const DEFAULT_CHANNEL = 'inapp';
/** 回滚时写在 marks.jsonl 里的来源（和 by 分开：一眼看出这是任务撤销退回来的，不是人改的） */
const UNDO_CHANNEL = 'undo';

interface AnnotateParams {
  channel: string;
  label: string;
}

function paramsOf(params: Record<string, unknown> | undefined): AnnotateParams {
  const channel = typeof params?.['channel'] === 'string' ? params['channel'] : DEFAULT_CHANNEL;
  const label = typeof params?.['label'] === 'string' ? params['label'].trim() : '';
  return { channel, label };
}

/** 变更前后的值都用同一句话描述，事件与 items 里都好读（也方便对账时肉眼比） */
function describe(stars: number, del: boolean): string {
  return `stars:${stars},del:${del}`;
}

function validate(draft: JobDraft, ctx: JobContext): JobProblem[] {
  const problems: JobProblem[] = [];
  const channel = draft.params['channel'] ?? DEFAULT_CHANNEL;
  if (typeof channel !== 'string' || !channelById(channel)) {
    problems.push({ field: 'params.channel', message: `要选一个已配置的通道：${channelIds().join(' / ')}` });
  }
  const label = draft.params['label'];
  if (typeof label !== 'string' || !label.trim()) {
    problems.push({ field: 'params.label', message: '要带 params.label：批注者的名字（回流记 by: link:<名字>，会出现在标注变更日志里）' });
  } else if (label.includes('|') || label.includes('\n')) {
    problems.push({ field: 'params.label', message: '名字里别带 `|` 或换行（签名载荷用 `|` 分隔字段）' });
  } else if (label.trim().length > 40) {
    problems.push({ field: 'params.label', message: `名字太长了（${label.trim().length} 字，最多 40）` });
  }
  if (!ctx.lib.select(draft.selection).length) {
    problems.push({ field: 'selection', message: '这个选择集里一张照片都没有（改改条件，或者干脆别建这个任务）' });
  }
  return problems;
}

/** 展开成快照：一张照片一项（配对在扫描阶段就已经合成一条记录） */
function plan(draft: JobDraft, ctx: JobContext): JobItem[] {
  return ctx.lib.select(draft.selection).map((rec) => ({
    id: rec.id,
    displayName: rec.displayName,
    status: 'planned' as const,
  }));
}

function apply(job: Job, ctx: JobContext, sink: JobSink): JobOutcome {
  const { channel, label } = paramsOf(job.params);
  const { token, expiresAt } = ctx.signRangeToken(job.id, label);
  sink.patch({ channel, dispatchedAt: new Date().toISOString() });
  sink.artifact({ kind: 'url', path: `/j?t=${token}` });
  sink.event({
    type: 'dispatched',
    channel,
    note: `批次链接已签发：${job.items.length} 张，批注者「${label}」，${expiresAt.slice(0, 10)} 前有效（链接只读这个任务里的照片）`,
  });
  return { state: 'running', note: '等外部批注回流（POST /jobs/{id}/inbound）' };
}

async function inbound(job: Job, items: InboundWrite[], ctx: JobContext, sink: JobSink): Promise<InboundOutcome> {
  const { channel } = paramsOf(job.params);
  const by = items[0]?.by ?? null;
  sink.event({ type: 'inbound', channel, by, note: `收到 ${items.length} 项回流` });

  // 先把「改之前是什么样」拍下来：items 里的 from、事件里的 from、以及有没有覆盖别人的批注
  const before = new Map<string, { stars: number; del: boolean; by: string | null }>();
  for (const item of items) {
    const snap = ctx.lib.marksOf(item.photoId);
    if (snap) before.set(item.photoId, snap);
  }

  const marks: MarkInput[] = items.map((item) => ({
    id: item.photoId,
    stars: item.stars,
    del: item.del,
    at: item.at,
    by: item.by,
    channel,
    jobId: job.id,
  }));
  const results = await ctx.lib.applyMarks(marks);

  const inputOf = new Map(items.map((i) => [i.photoId, i]));
  for (const result of results) {
    const input = inputOf.get(result.id);
    if (!input) continue;
    const prev = before.get(result.id);
    const clientRef = input.clientRef ?? null;
    const at = input.at ?? null;
    if (!result.ok) {
      const reason = result.error ?? '写入失败';
      sink.item(result.id, { status: 'failed', note: reason, at, clientRef });
      sink.event({ type: 'failed', photoId: result.id, by: input.by, channel, clientRef, note: reason });
      continue;
    }
    const from = prev ? describe(prev.stars, prev.del) : null;
    const to = describe(result.stars ?? 0, result.del ?? false);
    const asked = input.stars !== undefined || input.del !== undefined;
    const changed = from !== to;
    sink.item(result.id, {
      status: asked && changed ? 'done' : 'skipped',
      stars: result.stars ?? 0,
      del: result.del ?? false,
      at,
      clientRef,
      from,
      to,
      note: changed ? null : asked ? '标注本来就是这样的，没写日志' : '这项没带 stars/del，只记了一次回执',
    });
    if (prev?.by && prev.by !== input.by) {
      sink.event({
        type: 'conflict',
        photoId: result.id,
        from: prev.by,
        to: input.by,
        by: input.by,
        channel,
        clientRef,
        note: `这张原来是 ${prev.by} 标的，现在被 ${input.by} 覆盖`,
      });
    }
    sink.event({
      type: changed ? 'applied' : 'skipped',
      photoId: result.id,
      from,
      to,
      by: input.by,
      channel,
      clientRef,
      note: changed ? null : '标注没有变化，跳过',
    });
  }
  return { results };
}

async function undo(job: Job, ctx: JobContext, sink: JobSink): Promise<JobOutcome> {
  // marks.jsonl 里本任务写下的**全部**变更（最新在前）：一张照片可能被改过多次，
  // **最早的 from** 才是任务前的样子。不能只取最近 1000 条 —— 大任务会回滚错（reviewer 2026-10-07）。
  const changes = ctx.lib.historyForJob(job.id);
  const earliest = new Map<string, { stars?: number; del?: boolean }>();
  for (const change of [...changes].reverse()) {
    const back = earliest.get(change.photoId) ?? {};
    if (change.field === 'stars' && back.stars === undefined && typeof change.from === 'number') back.stars = change.from;
    if (change.field === 'del' && back.del === undefined && typeof change.from === 'boolean') back.del = change.from;
    earliest.set(change.photoId, back);
  }

  const wanted: MarkInput[] = [];
  for (const [photoId, back] of earliest) {
    if (back.stars === undefined && back.del === undefined) continue;
    const snap = ctx.lib.marksOf(photoId);
    if (!snap) {
      sink.event({ type: 'note', photoId, note: '这张照片已经不在库里了，回滚跳过' });
      continue;
    }
    // 没记录到的那个字段说明本任务没动过它，用当前值（不是「清成 0」）
    const stars = back.stars ?? snap.stars;
    const del = back.del ?? snap.del;
    if (stars === snap.stars && del === snap.del) {
      sink.event({ type: 'skipped', photoId, note: '标注已经回到原值了，不用动' });
      continue;
    }
    wanted.push({ id: photoId, stars, del, by: 'me', channel: UNDO_CHANNEL, jobId: job.id });
  }

  if (!wanted.length) {
    return { note: changes.length ? '标注已经回到原值了，没有需要回滚的' : '这个任务还没写下过标注，没有需要回滚的' };
  }

  const before = new Map<string, string>();
  for (const item of wanted) {
    const snap = ctx.lib.marksOf(item.id);
    if (snap) before.set(item.id, describe(snap.stars, snap.del));
  }
  const results = await ctx.lib.applyMarks(wanted);
  let rolled = 0;
  for (const result of results) {
    if (!result.ok) {
      sink.event({ type: 'failed', photoId: result.id, by: 'me', channel: UNDO_CHANNEL, note: result.error ?? '回滚失败' });
      continue;
    }
    rolled += 1;
    sink.event({
      type: 'undone',
      photoId: result.id,
      from: before.get(result.id) ?? null,
      to: describe(result.stars ?? 0, result.del ?? false),
      by: 'me',
      channel: UNDO_CHANNEL,
      note: '按本任务写下的 from 回滚',
    });
  }
  return { note: rolled ? `已回滚 ${rolled} 张的标注（用 marks.jsonl 里本任务写下的 from 值）` : '没有回滚成功的项' };
}

export const annotate: JobHandler = {
  kind: 'annotate',
  label: '推一批照片给人批注',
  params: {
    channel: { type: 'string', default: DEFAULT_CHANNEL, description: '出站通道（GET /channels 里的 id）' },
    label: { type: 'string', required: true, description: '批注者别名：回流记 by: link:<别名>（<= 40 字，不能带 | 与换行）' },
  },
  sideEffect: 'mark',
  undoable: true,
  needsNetwork: false,
  validate,
  plan,
  apply,
  inbound,
  undo,
};
