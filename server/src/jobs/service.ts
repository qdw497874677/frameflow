/**
 * 任务层服务：把「注册表里的 handler」和「core/jobs.ts 的状态机 + 事件日志」接起来。
 *
 * 职责：
 *  - `create`：校验 → 展开成 items 快照（handler.plan）→ plan 模式到此为止（**不落库**）、
 *    apply 模式落库入队；
 *  - 队列：**进程内**一个简单 runner（不持久化、不做 worker 池、不做调度器）——
 *    重启后 queued/running 由 core/jobs.ts 收敛成 interrupted，要接着跑就重新发起；
 *  - `cancel` / `undo` / `inbound`：状态机合法性在这里判，业务细节在 handler；
 *  - 收尾规则：任务 `running` 且所有 items 都有终态 → `done`（回流型任务靠这条收掉）。
 *
 * HTTP 语义（哪个错误对哪个状态码）不在这里：抛 `JobError`，由 api/server.ts 映射。
 */

import { createHash } from 'node:crypto';
import { OperationGates } from '../core/operation-gates.ts';
import { JobError, JobsStore, itemsSettled, type ConfirmationProjection, type Job, type JobEvent, type JobItem, type JobProblem } from '../core/jobs.ts';
import type { MarkResultDto } from '../core/marks.ts';
import type { Selection } from '../core/selection.ts';
import type { InboundInput, JobContext, JobHandler, JobSink } from './registry.ts';

/** 能被取消的状态（已经收尾的任务不能「取消」，要退就用 undo） */
const CANCELLABLE = ['planned', 'queued', 'running', 'interrupted'];

/** 能收回流的状态（planned/queued 还没派出去；interrupted 是重启后的收敛态，收到回流会接着跑；done/cancelled 已经收摊） */
const ACCEPTING = ['running', 'interrupted'];

export interface JobCreateInput {
  kind: string;
  selection: Selection;
  params: Record<string, unknown>;
  mode: 'plan' | 'apply';
  by?: string | null;
  /** 签发范围 token 时绑上的 API token id（会话/免认证签发时为 null）：撤销即失效 */
  tokenId?: string | null;
}

/** 从确认快照创建（F13）：jobId 由调用方预分配，items 即快照，不再重新展开选择集 */
export interface ConfirmedJobInput {
  jobId: string;
  requestId: string;
  kind: string;
  selection: Selection;
  params: Record<string, unknown>;
  /** 快照里的照片（顺序即 items 顺序） */
  items: Array<{ id: string; displayName?: string }>;
  by?: string | null;
  tokenId?: string | null;
  /** F23：明确确认模式（外部目标派发时启用）；缺省旧语义 */
  confirmationMode?: 'explicit' | null;
}

export function confirmedFingerprint(input: Pick<ConfirmedJobInput, 'jobId' | 'kind' | 'selection' | 'params' | 'items' | 'confirmationMode'>): string {
  const base = [input.jobId, input.kind, canonical(input.selection), canonical(input.params), input.items.map((i) => i.id)];
  // 旧指纹保持不变：只有 explicit 模式才追加
  const canon = JSON.stringify(input.confirmationMode === 'explicit' ? [...base, 'explicit'] : base);
  return createHash('sha256').update(canon).digest('hex');
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export class JobsService {
  private readonly store: JobsStore;
  private readonly registry: Record<string, JobHandler>;
  private readonly ctx: JobContext;
  private readonly queue: string[] = [];
  private pumping = false;
  /** jobId → 签发它范围 token 的 API token id（只活在内存：apply 只在创建后跑一次） */
  private readonly issuedBy = new Map<string, string | null>();
  /** jobId → 回流串行链：clientRef 幂等靠「先查再写」，并发重发必须在写盘前就排上队 */

  constructor(store: JobsStore, registry: Record<string, JobHandler>, ctx: JobContext) {
    this.store = store;
    this.registry = registry;
    this.ctx = ctx;
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  /** 给别人在错误信息里列清单用 */
  knownKinds(): string[] {
    return Object.keys(this.registry).sort();
  }

  handlerOf(kind: string): JobHandler | undefined {
    return this.registry[kind];
  }

  list(opts: { state?: string; limit?: number } = {}): Job[] {
    return this.store.list(opts);
  }

  get(id: string): Job {
    const job = this.store.get(id);
    if (!job) throw new JobError('notfound', `没这个任务：${id}`);
    return job;
  }

  events(id: string, opts: { since?: number; limit?: number } = {}): { items: JobEvent[]; nextSince: number } {
    // 先确认任务存在（不存在该 404，而不是空列表）
    this.get(id);
    return this.store.events(id, opts);
  }

  /** 这张照片在不在这批里（范围 token 读缩略图时的开关） */
  hasItem(id: string, photoId: string): boolean {
    return this.store.hasItem(id, photoId);
  }

  /** 范围 token 的撤销模型：任务没了、被撤销了，链接立刻失效 */
  rangeTokenValid(id: string): boolean {
    const job = this.store.get(id);
    return job !== undefined && job.state !== 'cancelled';
  }

  // ── 创建 ────────────────────────────────────────────────────────────────

  /**
   * plan 模式返回一个「要是真建会长这样」的任务（**不落库、不签 token、不占 id**，id 固定为 `plan`）；
   * apply 模式落库、入队、返回 `planned`/`queued`（执行随后在后台推，201 先走）。
   */
  async create(input: JobCreateInput): Promise<Job> {
    const kind = input.kind.trim();
    const handler = this.registry[kind];
    if (!handler) {
      const known = this.knownKinds();
      throw new JobError('invalid', `没注册这个任务类型：${kind || '(空)'}。可用：${known.length ? known.join(' / ') : '（一个都没有）'}`);
    }
    const draft = { kind, selection: input.selection, params: input.params };
    const problems: JobProblem[] = handler.validate(draft, this.ctx);
    if (problems.length) {
      throw new JobError('invalid', `任务参数不对：${problems.map((p) => `${p.field} ${p.message}`).join('；')}`, problems);
    }
    const items: JobItem[] = (await handler.plan(draft, this.ctx)).map((item) => ({ ...item, status: item.status ?? 'planned' }));
    if (input.mode === 'plan') {
      return {
        id: 'plan',
        kind,
        state: 'planned',
        selection: input.selection,
        params: input.params,
        channel: null,
        dispatchedAt: null,
        progress: { done: 0, total: items.length },
        items,
        artifacts: [],
        error: null,
        reversible: handler.undoable,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };
    }
    const job = this.store.create({
      kind,
      selection: input.selection,
      params: input.params,
      items,
      reversible: handler.undoable,
      state: 'planned',
      by: input.by ?? null,
    });
    const queued = this.store.setState(job.id, 'queued');
    this.issuedBy.set(job.id, input.tokenId ?? null);
    this.queue.push(job.id);
    // 让 201 先带着 queued 出去（契约：创建返回 planned|queued），执行在下一个 tick 开始
    setTimeout(() => void this.pump(), 0);
    return queued;
  }

  /**
   * 确认式幂等创建（F13）。同步完成「查 requestId → 落库 → 入队」，中间没有 await，
   * 所以并发的同一请求只会有一个落库；重放返回同一任务，异载荷 409。
   * 若之前崩在「落库后、入队前」（state 仍 planned），重放会把它补入队列。
   */
  createConfirmed(input: ConfirmedJobInput): Job {
    const kind = input.kind.trim();
    const handler = this.registry[kind];
    if (!handler) throw new JobError('invalid', `没注册这个任务类型：${kind || '(空)'}`);
    if (!input.requestId || !input.jobId) throw new JobError('invalid', '确认式创建要带 jobId 与 requestId');
    const fp = confirmedFingerprint({ ...input, kind });
    const existing = this.store.byRequestId(input.requestId) ?? this.store.get(input.jobId);
    if (existing) {
      if (existing.requestId !== input.requestId || existing.requestFingerprint !== fp) {
        throw new JobError('conflict', '同一 requestId 的确认内容不一致（或 jobId 已被占用），请重新预览');
      }
      if (existing.state === 'planned') return this.enqueue(existing.id, input.tokenId ?? null);
      return existing;
    }
    if (!input.items.length) throw new JobError('invalid', '快照里没有照片');
    const problems = handler.validate({ kind, selection: input.selection, params: input.params }, this.ctx);
    if (problems.length) throw new JobError('invalid', `任务参数不对：${problems.map((p) => `${p.field} ${p.message}`).join('；')}`, problems);
    const job = this.store.create({
      id: input.jobId,
      requestId: input.requestId,
      requestFingerprint: fp,
      kind,
      selection: input.selection,
      params: input.params,
      items: input.items.map((i) => ({ id: i.id, ...(i.displayName ? { displayName: i.displayName } : {}), status: 'planned' as const })),
      reversible: handler.undoable,
      state: 'planned',
      by: input.by ?? null,
      confirmationMode: input.confirmationMode ?? null,
    });
    return this.enqueue(job.id, input.tokenId ?? null);
  }

  private enqueue(id: string, tokenId: string | null): Job {
    const queued = this.store.setState(id, 'queued');
    this.issuedBy.set(id, tokenId);
    this.queue.push(id);
    setTimeout(() => void this.pump(), 0);
    return queued;
  }

  // ── 执行 ────────────────────────────────────────────────────────────────

  /** 进程内队列：一次一个（v1 不做并发/调度），失败只影响这个任务 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const job = this.store.get(id);
        if (!job || job.state !== 'queued') continue; // 入队后被取消的，跳过
        const handler = this.registry[job.kind];
        const sink = this.sinkFor(id);
        if (!handler) {
          this.fail(id, `没注册这个任务类型：${job.kind}`);
          continue;
        }
        let outcome;
        try {
          outcome = await handler.apply(this.store.setState(id, 'running'), this.ctxFor(id), sink);
        } catch (err) {
          this.fail(id, err instanceof Error ? err.message : String(err));
          continue;
        }
        if (outcome.error) this.store.patch(id, { error: outcome.error });
        if (outcome.note) sink.event({ type: 'note', note: outcome.note });
        if (outcome.state === 'failed') {
          this.fail(id, outcome.error ?? '任务失败');
        } else if (outcome.state === 'done') {
          this.finish(id);
        } else {
          // 还等着回流：只有这一批全有终态时才收（apply 就该把 items 推成终态的情况也走这里）
          this.settle(id);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 给某个任务定制的 ctx：把「签发这条链接的 API token」封进去（handler 自己不用知道） */
  private ctxFor(jobId: string): JobContext {
    const tokenId = this.issuedBy.get(jobId) ?? null;
    return { ...this.ctx, signRangeToken: (id, alias) => this.ctx.signRangeToken(id, alias, tokenId) };
  }

  private fail(id: string, message: string): void {
    const job = this.store.get(id);
    // 已经被取消/收尾的任务不要再迁移：setState 会抛 conflict，从 pump 里逃逸就是 unhandled rejection
    if (!job || job.state === 'done' || job.state === 'cancelled' || job.state === 'failed') return;
    this.store.setState(id, 'failed', { error: message });
    this.store.addEvent(id, { type: 'failed', note: message });
  }

  /** 全部 items 有终态 → done（回流型任务靠这条收掉） */
  private settle(id: string): Job | undefined {
    const job = this.store.get(id);
    if (!job || job.state !== 'running' || !itemsSettled(job.items)) return job;
    return this.finish(id);
  }

  private finish(id: string): Job {
    const job = this.get(id);
    // 回流 settle 与 pump 可能撞在一起：已经收过尾的不再补一个 done 事件
    if (job.state === 'done' || job.state === 'cancelled' || job.state === 'failed') return job;
    const settled = job.items.filter((i) => i.status !== 'planned').length;
    const done = this.store.setState(id, 'done');
    this.store.addEvent(id, { type: 'done', note: `全部 ${done.items.length} 个项目有终态（完成 ${settled}，跳过/失败也算有交代）` });
    if (this.ctx.onDone) {
      const after = this.store.get(id) ?? done;
      let generation = 0;
      for (let since = 0, guard = 0; guard < 10_000; guard++) {
        const page = this.store.events(id, { since, limit: 500 });
        generation += page.items.filter((e) => e.type === 'done').length;
        if (!page.items.length || page.nextSince <= since) break;
        since = page.nextSince;
      }
      try { this.ctx.onDone(after, generation); } catch { /* 通知失败不影响任务收尾 */ }
    }
    return done;
  }

  private sinkFor(jobId: string): JobSink {
    return {
      jobId,
      event: (ev) => void this.store.addEvent(jobId, ev),
      item: (itemId, patch) => void this.store.updateItem(jobId, itemId, patch),
      artifact: (artifact) => void this.store.addArtifact(jobId, artifact),
      patch: (patch) => void this.store.patch(jobId, patch),
      progress: () => this.store.get(jobId)?.progress ?? { done: 0, total: 0 },
    };
  }

  // ── 明确确认投影（F23）──────────────────────────────────────────────────

  /** 任务级串行边界（供确认控制器在锁内复验 + 提交 + 投影） */
  runInJobGate<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    return this.withJob(id, fn);
  }

  /** 已提交 marks 事务 → 任务确认投影；调用方持 job gate 或由这里取。重复 sourceOpId 不重复计数。 */
  async projectConfirmation(id: string, p: ConfirmationProjection): Promise<{ replayed: boolean; job: Job }> {
    return this.withJob(id, () => {
      const job = this.get(id);
      if (!['running', 'interrupted', 'done'].includes(job.state)) throw new JobError('conflict', `任务处于 ${job.state}，不收确认`);
      if (job.state === 'interrupted') this.store.setState(id, 'running');
      const out = this.store.projectConfirmation(id, p);
      if (!out.replayed && job.state !== 'done') this.settle(id);
      return { replayed: out.replayed, job: this.get(id) };
    });
  }

  hasProjected(id: string, sourceOpId: string): boolean { return this.store.hasProjected(id, sourceOpId); }

  // ── 取消 / 撤销 / 回流 ──────────────────────────────────────────────────

  /** F06：任务级串行边界，顺序 job → photo（锁内 applyMarks 再取 photo 锁；普通标记不取 job 锁） */
  private withJob<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    return this.ctx.lib.gates.run([OperationGates.job(id)], fn);
  }

  async cancel(id: string): Promise<Job> {
    return this.withJob(id, () => this.cancelLocked(id));
  }

  private cancelLocked(id: string): Job {
    const job = this.get(id);
    if (!CANCELLABLE.includes(job.state)) {
      throw new JobError('conflict', `任务已经是 ${job.state}，取消不了（要退回标注请用 undo）`);
    }
    const cancelled = this.store.setState(id, 'cancelled');
    this.store.addEvent(id, {
      type: 'cancelled',
      note: '任务被取消（已写的标注留着，要退回请 undo；范围 token 随之失效）',
    });
    return cancelled;
  }

  async undo(id: string): Promise<Job> {
    return this.withJob(id, () => this.undoLocked(id));
  }

  private async undoLocked(id: string): Promise<Job> {
    // 锁内重新读状态与 undone：并发撤销只有一个能真正回滚
    const job = this.get(id);
    const handler = this.registry[job.kind];
    if (!job.reversible || !handler?.undo) {
      throw new JobError('conflict', `这个任务不可撤销（kind=${job.kind}，reversible=${job.reversible}）`);
    }
    if (this.store.hasEvent(id, 'undone')) {
      throw new JobError('conflict', '这个任务已经撤销过了');
    }
    const outcome = await handler.undo(job, this.ctx, this.sinkFor(id));
    if (outcome.state === 'failed') throw new JobError('conflict', outcome.error ?? '撤销失败');
    // 已取消的任务照样能撤销（回滚它写过的标注）——取消的提示里就写着「要退回请 undo」。
    // 但它已经是 cancelled，不必再迁一次状态（状态机不允许 cancelled → cancelled）。
    const undone = job.state === 'cancelled' ? this.get(id) : this.store.setState(id, 'cancelled', { error: null });
    this.store.addEvent(id, { type: 'undone', note: outcome.note ?? '任务已撤销，本任务写下的标注已回滚' });
    return undone;
  }

  /**
   * 外部回流（对外入口）：同一任务的请求串行处理 —— clientRef 幂等靠「先查 items 再写」，
   * 并发重发会在写盘的 await 窗口里互相看不见、重复落标，所以在进业务逻辑前排上队。
   */
  async inbound(id: string, raw: InboundInput[], by: string): Promise<MarkResultDto[]> {
    // F06：与 cancel/undo 共用 job gate，锁内重新检查终态
    return this.withJob(id, () => this.inboundOnce(id, raw, by));
  }

  /**
   * 外部回流：`by` 由凭据推（范围 token → `link:<批注人>`，主凭据 → `me`），**请求体里的 by 不算数**。
   * 只认这个任务 items 里的照片（别的照片 404）、clientRef 幂等（重复的跳过并返回首次结果）。
   */
  private async inboundOnce(id: string, raw: InboundInput[], by: string): Promise<MarkResultDto[]> {
    const job = this.get(id);
    const inJob = new Set(job.items.map((i) => i.id));
    for (const item of raw) {
      if (!inJob.has(item.photoId)) {
        throw new JobError('notfound', `这张照片不在这个任务里：${item.photoId}`);
      }
    }

    // clientRef 幂等：见过的直接回首次结果（外部系统整批重发是常态）。
    // 先分类再判状态：**整批都是老 clientRef 的重放**不算新回流，任务已经 done 也照样回 200
    // —— 重发的意思就是「我这条你到底记下没有」，不该因为任务收掉了就变成 409。
    const firstByRef = new Map<string, JobItem>();
    for (const item of job.items) {
      if (item.clientRef) firstByRef.set(item.clientRef, item);
    }
    const results: MarkResultDto[] = new Array(raw.length);
    const fresh: InboundInput[] = [];
    const freshAt: number[] = [];
    const repeat: { at: number; item: InboundInput; seen: JobItem }[] = [];
    raw.forEach((item, idx) => {
      const seen = item.clientRef ? firstByRef.get(item.clientRef) : undefined;
      if (!seen) {
        fresh.push(item);
        freshAt.push(idx);
        return;
      }
      repeat.push({ at: idx, item, seen });
    });

    if (fresh.length && !ACCEPTING.includes(job.state)) {
      throw new JobError('conflict', `任务处于 ${job.state}，现在不收回流（要重发同一批已经写过的项就带原来的 clientRef）`);
    }
    // 重启把任务收敛成 interrupted（没有执行者了），但批注链接还在人家手机上：
    // 一收到新回流就接着跑（items 历史不动，只把状态拉回 running）。
    if (fresh.length && job.state === 'interrupted') {
      this.store.setState(id, 'running');
      this.store.addEvent(id, { type: 'note', by, note: '服务重启过（任务曾被收敛为 interrupted）；收到回流，接着跑' });
    }

    for (const dup of repeat) {
      const seen = dup.seen;
      results[dup.at] = { id: dup.item.photoId, ok: true, stars: seen.stars ?? 0, del: seen.del ?? false, error: null };
      this.store.addEvent(id, {
        type: 'skipped',
        photoId: dup.item.photoId,
        by,
        clientRef: dup.item.clientRef ?? null,
        note: `clientRef ${dup.item.clientRef} 已经处理过（当前 stars:${seen.stars ?? 0},del:${seen.del ?? false}），这次跳过`,
      });
    }

    if (fresh.length) {
      const handler = this.registry[job.kind];
      if (!handler?.inbound) {
        throw new JobError('invalid', `任务类型 ${job.kind} 不收回流`);
      }
      // 让 handler 用「回流那一刻」的任务快照（items 的 clientRef 不能重复用）
      const snapshot = this.get(id);
      const outcome = await handler.inbound(snapshot, fresh.map((item) => ({ ...item, by })), this.ctx, this.sinkFor(id));
      fresh.forEach((item, n) => {
        const got = outcome.results.find((r) => r.id === item.photoId);
        results[freshAt[n]!] = got ?? { id: item.photoId, ok: false, error: '这个任务类型没有为这一项给出结果' };
      });
    }

    // 全部有终态就收尾
    this.settle(id);
    return results;
  }
}
