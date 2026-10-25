/**
 * 飞书确认控制器（F24）。
 *
 * 受理：校验 session 绑定（实例/租户/目标/消息/期限）→ 预检授权 → 动作意图可靠落盘 → 立即回「处理中」。
 * 处理（后台，任务锁内）：复验任务终态、授权（排队期间撤权也拦）、照片在快照且可达 → 以稳定 opId 提交
 * marks 事务（expectedRevisions/Generations 来自 session，旧卡片竞争只成功一项）→ 投影到任务确认集合
 * → 锁外更新卡片到下一张。表单草稿（选星不提交）不回调，不落标。
 * 恢复：重启后把仍为 accepted 的动作重新处理；已提交的 opId 由 marks 重放，只补投影，不重复写标记。
 */
import { decideAccess, findSourceTarget, type ConnectorOperation } from '../../connectors/access.ts';
import type { ConnectorConfigDocument, ConnectorEvent, DeliveryResult, EventAck, SemanticContent } from '../../connectors/types.ts';
import type { CardModel } from '../../connectors/feishu/cards.ts';
import { confirmationSummary, type ConfirmationProjection, type Job } from '../../core/jobs.ts';
import type { MarkTransactionRequest, MarkTransactionResult } from '../../core/mark-transaction.ts';
import type { ActionIntent, ActionLog, ActionOutcome } from './actions.ts';
import type { CursorStore } from './cursors.ts';
import type { CardSession, SessionStore } from './sessions.ts';
import { parseCommand } from './commands.ts';
import { createHash } from 'node:crypto';

/** F26：飞书内创建任务所需能力（预览/确认复用 DeliveryPreview + ConfirmationService） */
export interface CreationDeps {
  readonly projectName: (projectId: string) => string | undefined;
  readonly preview: (projectId: string, target: { connectorId: string; targetId: string }) =>
    { ok: true; previewId: string; revision: string; photoCount: number } | { ok: false; code: string };
  readonly confirm: (input: { previewId: string; revision: string; requestId: string }) => Promise<{ jobId: string; replayed: boolean }>;
}

export const LIST_PAGE_SIZE = 5;

export interface ControllerDeps {
  readonly sessions: SessionStore;
  readonly actions: ActionLog;
  readonly cursors: CursorStore;
  readonly config: () => ConnectorConfigDocument;
  readonly jobs: {
    get(id: string): Job | undefined;
    runInJobGate<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
    projectConfirmation(id: string, p: ConfirmationProjection): Promise<unknown>;
  };
  readonly marks: {
    transactMarks(r: MarkTransactionRequest): Promise<MarkTransactionResult>;
    markVersion(photoId: string): { revision: number; generation: string | null } | null;
  };
  readonly projectOf: (jobId: string) => string | undefined;
  readonly deliveredTargets: (jobId: string) => readonly string[];
  readonly send: (connectorId: string, input: { targetId: string; intentId: string; content: SemanticContent; sessionId?: string }) => Promise<DeliveryResult>;
  readonly update: (connectorId: string, input: { targetId: string; intentId: string; messageId: string; content: SemanticContent; sessionId?: string }) => Promise<DeliveryResult>;
  readonly now?: () => number;
  /** F25：投递到某目标的任务（列表只列可见任务） */
  readonly jobsForTarget?: (connectorId: string, targetId: string) => readonly Job[];
  readonly creation?: CreationDeps;
}

/** 动作 → 所需授权 */
const OPERATION: Record<string, ConnectorOperation> = {
  open: 'viewTask', skip: 'viewTask', prev: 'viewTask', refresh: 'viewTask', review: 'viewTask', submit: 'annotate', remark: 'annotate', list: 'viewTask', reopen: 'viewTask',
  // 无任务的交互卡（列表/帮助/创建）
  'list-page': 'help', 'list-prev': 'help', help: 'help', create: 'help', pick: 'create', 'confirm-create': 'create', 'cancel-create': 'help',
};
/** 不绑定任务的会话 */
const META_KINDS = new Set(['task-list', 'help', 'create-project', 'create-preview']);
const CLOSED = new Set(['cancelled', 'failed', 'planned']);

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export class FeishuController {
  readonly #d: ControllerDeps;
  /** 后台处理（测试/关停等待） */
  readonly background = new Set<Promise<unknown>>();
  /** 消息事件重投去重（命令只开卡片，重复最多多发一张；仍去重） */
  readonly #seen = new Set<string>();

  constructor(deps: ControllerDeps) { this.#d = deps; }

  #now(): number { return (this.#d.now ?? Date.now)(); }

  /** 连接器事件入口（ConnectorRuntime onEvent） */
  async handle(connectorId: string, ev: ConnectorEvent): Promise<EventAck> {
    const p = ev.payload;
    if (p['type'] === 'message') return this.#command(connectorId, ev);
    if (p['type'] !== 'card-action') return { kind: 'rejected', code: 'UNSUPPORTED_EVENT' };
    const actionId = typeof p['actionId'] === 'string' ? p['actionId'] : '';
    if (!OPERATION[actionId]) return { kind: 'rejected', code: 'ACTION_UNKNOWN' };
    const inst = this.#d.config().instances.find((i) => i.id === connectorId);
    const target = inst && ev.source ? findSourceTarget(inst, ev.source) : undefined;
    const chk = this.#d.sessions.check(p['sessionId'], { connectorId, tenantId: ev.identity.tenantId, targetId: target?.id ?? null, messageId: ev.messageId }, this.#now());
    if (!chk.ok && chk.code === 'SESSION_EXPIRED' && (actionId === 'reopen' || actionId === 'refresh' || actionId === 'open')) {
      // F25：过期卡片重开：发新卡片，旧 session 撤销
      const old = this.#d.sessions.get(String(p['sessionId']));
      if (old && !META_KINDS.has(old.kind) && old.connectorId === connectorId && old.tenantId === ev.identity.tenantId && old.targetId === target?.id) {
        const denied = this.#authorize(connectorId, ev, old, 'reopen');
        if (denied) return { kind: 'rejected', code: denied, toast: '没有权限' };
        this.#d.sessions.revoke(old.sessionId);
        this.#track(this.render(old, old.photoId, { fresh: true }));
        return { kind: 'accepted', toast: '已重新发送卡片' };
      }
    }
    if (!chk.ok) return { kind: 'rejected', code: chk.code, toast: chk.code === 'SESSION_EXPIRED' ? '卡片已过期，请点「重新打开」或发送「继续」' : '这张卡片不能在这里操作' };
    const session = chk.session;
    const payload = this.#payload(actionId, p['form']);
    if (!payload) return { kind: 'rejected', code: 'INVALID_FORM', toast: '请选择星级' };
    const pre = this.#authorize(connectorId, ev, session, actionId);
    if (pre) return { kind: 'rejected', code: pre, toast: '没有权限' };
    const r = this.#d.actions.accept({ sessionId: session.sessionId, actionId, actorId: ev.identity.actorId, payload, source: ev.source ? { ...ev.source } : null, messageId: ev.messageId ?? null }, this.#now());
    if (r.kind === 'rejected') return { kind: 'rejected', code: r.code, toast: r.code === 'OVERLOADED' ? '太忙了，请稍后再试' : '这张卡片已提交过不同的选择，请刷新' };
    if (r.kind === 'replay') return { kind: 'accepted', toast: r.outcome ? (r.outcome.status === 'done' ? '已处理' : '处理失败，请刷新') : '处理中' };
    this.#spawn(r.intent);
    return { kind: 'accepted', toast: '处理中' };
  }

  /** 重启恢复：重新处理所有仍为 accepted 的动作 */
  recover(): number {
    const pending = this.#d.actions.pending();
    for (const a of pending) this.#spawn(a);
    return pending.length;
  }

  async idle(): Promise<void> { while (this.background.size) await Promise.allSettled([...this.background]); }

  #spawn(a: ActionIntent): void { this.#track(this.process(a)); }

  #track(p: Promise<unknown>): void {
    const run: Promise<unknown> = p.catch(() => undefined).finally(() => this.background.delete(run));
    this.background.add(run);
  }

  /** F26：文本命令。只开卡片，不写标记。 */
  async #command(connectorId: string, ev: ConnectorEvent): Promise<EventAck> {
    if (!ev.source) return { kind: 'rejected', code: 'SOURCE_MISSING' };
    const cmd = parseCommand(ev.payload, ev.source.kind);
    if (!cmd) return { kind: 'rejected', code: 'NOT_MENTIONED' };
    const dedup = ev.eventId ?? ev.messageId;
    if (dedup) { if (this.#seen.has(dedup)) return { kind: 'accepted' }; this.#seen.add(dedup); if (this.#seen.size > 1024) this.#seen.delete(this.#seen.values().next().value!); }
    const inst = this.#d.config().instances.find((i) => i.id === connectorId);
    const target = inst ? findSourceTarget(inst, ev.source) : undefined;
    const base = { connectorId, identity: ev.identity, source: ev.source };
    const help = decideAccess(this.#d.config(), { ...base, operation: 'help' });
    if (!help.allowed || !target) return { kind: 'rejected', code: help.allowed ? 'TARGET_NOT_CONFIGURED' : help.reason };
    const from = { connectorId, tenantId: ev.identity.tenantId, targetId: target.id };
    if (cmd.name === 'help') this.#track(this.renderMeta(from, 'help', { actorId: ev.identity.actorId }));
    else if (cmd.name === 'list') this.#track(this.renderMeta(from, 'task-list', { page: 0 }));
    else if (cmd.name === 'create') {
      if (!this.#creatorProjects(connectorId, ev.identity.actorId, target.id).length) return { kind: 'rejected', code: 'NOT_CREATOR', toast: '你没有在这里创建任务的权限' };
      this.#track(this.renderMeta(from, 'create-project', { actorId: ev.identity.actorId }));
    } else {
      // 继续：最近一个仍可确认的可见任务
      const job = this.#visibleJobs(connectorId, target.id).find((j) => j.state !== 'done');
      if (!job) this.#track(this.renderMeta(from, 'task-list', { page: 0 }));
      else {
        const s = { ...from, jobId: job.id };
        if (this.#authorize(connectorId, ev, { ...s } as CardSession, 'open')) return { kind: 'rejected', code: 'TASK_NOT_DELIVERED' };
        this.#track(this.render(s, this.#nextPhoto(job.id, null), { fresh: true }));
      }
    }
    return { kind: 'accepted' };
  }

  #visibleJobs(connectorId: string, targetId: string): Job[] {
    const all = this.#d.jobsForTarget?.(connectorId, targetId) ?? [];
    return all.filter((j) => !CLOSED.has(j.state) && this.#d.deliveredTargets(j.id).includes(targetId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  #creatorProjects(connectorId: string, actorId: string, targetId: string): string[] {
    const inst = this.#d.config().instances.find((i) => i.id === connectorId);
    const t = inst?.targets.find((x) => x.id === targetId);
    if (!inst || !t || !this.#d.creation || !inst.creatorActorIds.includes(actorId)) return [];
    return inst.creatorProjectIds.filter((p) => t.projectIds.includes(p) && this.#d.creation!.projectName(p) !== undefined);
  }

  /** 发一张不绑定任务的交互卡（列表/帮助/选项目/创建预览）；子按钮各自独立 session */
  async renderMeta(from: { connectorId: string; tenantId: string; targetId: string; messageId?: string | null }, kind: 'task-list' | 'help' | 'create-project' | 'create-preview',
    opts: { page?: number; actorId?: string; projectId?: string; previewId?: string; previewRevision?: string; photoCount?: number } = {}): Promise<CardSession> {
    const now = this.#now();
    const mk = (extra: Partial<CardSession> & { kind: CardSession['kind'] }) => this.#d.sessions.create({
      connectorId: from.connectorId, tenantId: from.tenantId, targetId: from.targetId, jobId: '', photoId: null, revision: null, generation: null, messageId: null, ...extra,
    } as Parameters<SessionStore['create']>[0], now);
    const children: { label: string; sessionId: string; actionId: string }[] = [];
    let page = opts.page ?? 0;
    if (kind === 'task-list') {
      const jobs = this.#visibleJobs(from.connectorId, from.targetId);
      page = Math.max(0, Math.min(page, Math.ceil(jobs.length / LIST_PAGE_SIZE) - 1));
      for (const j of jobs.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE)) {
        const c = mk({ kind: 'task-entry', jobId: j.id });
        children.push({ label: this.#jobLabel(j), sessionId: c.sessionId, actionId: j.state === 'done' ? 'review' : 'open' });
      }
    } else if (kind === 'create-project') {
      for (const pid of this.#creatorProjects(from.connectorId, opts.actorId ?? '', from.targetId).slice(0, 20)) {
        const c = mk({ kind: 'create-project', projectId: pid });
        children.push({ label: this.#d.creation!.projectName(pid) ?? pid, sessionId: c.sessionId, actionId: 'pick' });
      }
    }
    const s = mk({ kind, page, ...(opts.projectId ? { projectId: opts.projectId } : {}), ...(opts.previewId ? { previewId: opts.previewId, previewRevision: opts.previewRevision, photoCount: opts.photoCount } : {}), children });
    const content: SemanticContent = { type: 'session-card' };
    const intentId = `card_${s.sessionId}`;
    const r = from.messageId
      ? await this.#d.update(from.connectorId, { targetId: from.targetId, intentId, messageId: from.messageId, content, sessionId: s.sessionId })
      : await this.#d.send(from.connectorId, { targetId: from.targetId, intentId, content, sessionId: s.sessionId });
    const messageId = r.status === 'sent' ? r.messageId : from.messageId ?? null;
    if (messageId) {
      this.#d.sessions.bindMessage(s.sessionId, messageId);
      for (const c of children) this.#d.sessions.bindMessage(c.sessionId, messageId);
    }
    return s;
  }

  #jobLabel(j: Job): string {
    const sum = confirmationSummary(j, (id) => this.#d.marks.markVersion(id) !== null);
    const name = (j.params as { label?: unknown })?.label;
    const n = typeof name === 'string' && name ? name : `任务 ${j.id.slice(-6)}`;
    return sum ? `${n}（${sum.confirmed}/${sum.total}）` : n;
  }

  /** 交互卡动作（无任务锁；创建经 ConfirmationService，requestId 由 session 派生，重复点击只建一次） */
  async #processMeta(a: ActionIntent, s: CardSession): Promise<ActionOutcome> {
    const from = { connectorId: s.connectorId, tenantId: s.tenantId, targetId: s.targetId, messageId: s.messageId };
    const ev = { identity: { connectorId: s.connectorId, tenantId: s.tenantId, actorId: a.actorId }, source: a.source as ConnectorEvent['source'] };
    let outcome: ActionOutcome = { status: 'done' };
    try {
      const denied = this.#authorize(s.connectorId, ev, s, a.actionId);
      if (denied) throw new ActionError(denied);
      switch (a.actionId) {
        case 'list-page': await this.renderMeta(from, 'task-list', { page: (s.page ?? 0) + 1 }); break;
        case 'list-prev': await this.renderMeta(from, 'task-list', { page: Math.max(0, (s.page ?? 0) - 1) }); break;
        case 'help': await this.renderMeta(from, 'help', { actorId: a.actorId }); break;
        case 'create': case 'cancel-create': await this.renderMeta(from, a.actionId === 'create' ? 'create-project' : 'help', { actorId: a.actorId }); break;
        case 'pick': {
          const r = this.#d.creation!.preview(s.projectId!, { connectorId: s.connectorId, targetId: s.targetId });
          if (!r.ok) throw new ActionError(r.code);
          await this.renderMeta(from, 'create-preview', { projectId: s.projectId!, previewId: r.previewId, previewRevision: r.revision, photoCount: r.photoCount });
          break;
        }
        case 'confirm-create': {
          if (s.kind !== 'create-preview' || !s.previewId || !s.previewRevision) throw new ActionError('ACTION_UNKNOWN');
          const requestId = `fs_${createHash('sha256').update(s.sessionId).digest('hex').slice(0, 32)}`;
          await this.#d.creation!.confirm({ previewId: s.previewId, revision: s.previewRevision, requestId });
          this.#settle(a, outcome);
          if (s.messageId) await this.#d.update(s.connectorId, { targetId: s.targetId, intentId: `card_${s.sessionId}_done`, messageId: s.messageId, content: { type: 'session-card' }, sessionId: s.sessionId }).catch(() => undefined);
          return outcome;
        }
        default: throw new ActionError('ACTION_UNKNOWN');
      }
    } catch (e) {
      outcome = { status: 'failed', code: e instanceof ActionError ? e.code : (e as { code?: string }).code ?? 'INTERNAL' };
    }
    return this.#settle(a, outcome);
  }

  #payload(actionId: string, form: unknown): Record<string, unknown> | null {
    if (actionId !== 'submit' && actionId !== 'remark') return {};
    const f = (form && typeof form === 'object' ? form : {}) as Record<string, unknown>;
    const stars = Number(f['stars']);
    if (!Number.isInteger(stars) || stars < 0 || stars > 5 || f['stars'] === '' || f['stars'] === undefined) return null;
    const reject = f['reject'] === true || f['reject'] === 'true';
    return { stars, del: reject };
  }

  #authorize(connectorId: string, ev: { identity: ConnectorEvent['identity']; source: ConnectorEvent['source'] }, s: CardSession, actionId: string): string | null {
    if (META_KINDS.has(s.kind) || (s.kind === 'task-entry' && !s.jobId)) {
      const op = OPERATION[actionId]!;
      if (op !== 'help' && op !== 'create') return 'ACTION_UNKNOWN';
      if ((actionId === 'pick' && s.kind !== 'create-project') || (actionId === 'confirm-create' && s.kind !== 'create-preview')) return 'ACTION_UNKNOWN';
      if (op === 'create' && !this.#d.creation) return 'CREATE_UNAVAILABLE';
      const d = decideAccess(this.#d.config(), { connectorId, identity: ev.identity, source: ev.source, operation: op, ...(op === 'create' ? { projectId: s.projectId } : {}) });
      return d.allowed ? null : d.reason;
    }
    if (OPERATION[actionId] === 'help' || OPERATION[actionId] === 'create') return 'ACTION_UNKNOWN';
    const photo = s.photoId && (actionId === 'submit' || actionId === 'remark')
      ? { inTaskSnapshot: !!this.#d.jobs.get(s.jobId)?.items.some((i) => i.id === s.photoId), accessible: this.#d.marks.markVersion(s.photoId) !== null }
      : undefined;
    const d = decideAccess(this.#d.config(), {
      connectorId, identity: ev.identity, source: ev.source, operation: OPERATION[actionId]!,
      projectId: this.#d.projectOf(s.jobId), taskDeliveredTargetIds: this.#d.deliveredTargets(s.jobId), ...(photo ? { photo } : {}),
    });
    return d.allowed ? null : d.reason;
  }

  /** 处理一条已受理的动作；返回结局（也写回动作日志） */
  async process(a: ActionIntent): Promise<ActionOutcome> {
    const s = this.#d.sessions.get(a.sessionId);
    if (!s) return this.#settle(a, { status: 'failed', code: 'SESSION_NOT_FOUND' });
    if (META_KINDS.has(s.kind)) return this.#processMeta(a, s);
    let mode: 'confirm' | 'review' = s.mode ?? 'confirm';
    let next: { photoId: string | null } | null = null;
    let outcome: ActionOutcome;
    try {
      next = await this.#d.jobs.runInJobGate(s.jobId, async () => {
        const job = this.#d.jobs.get(s.jobId);
        if (!job || CLOSED.has(job.state)) throw new ActionError('JOB_CLOSED');
        const denied = this.#authorize(s.connectorId, { identity: { connectorId: s.connectorId, tenantId: s.tenantId, actorId: a.actorId }, source: a.source as ConnectorEvent['source'] }, s, a.actionId);
        if (denied) throw new ActionError(denied);
        if (a.actionId === 'submit' || a.actionId === 'remark') {
          const photoId = s.photoId;
          if (!photoId) throw new ActionError('NO_PHOTO');
          const item = job.items.find((i) => i.id === photoId);
          if (!item) throw new ActionError('PHOTO_NOT_IN_TASK');
          if (job.state === 'done' && !item.confirmedAt) throw new ActionError('JOB_CLOSED');
          const stars = a.payload['stars'] as number;
          const del = a.payload['del'] as boolean;
          const at = new Date(a.at).toISOString();
          let res: MarkTransactionResult;
          try {
            res = await this.#d.marks.transactMarks({
              opId: a.opId,
              items: [{ id: photoId, stars, del, by: a.actorId, channel: 'feishu', jobId: s.jobId, at }],
              ...(s.revision === null ? {} : { expectedRevisions: { [photoId]: s.revision } }),
              ...(s.generation === null ? {} : { expectedGenerations: { [photoId]: s.generation } }),
              confirmation: { jobId: s.jobId, photoId, sessionId: s.sessionId, actorId: a.actorId, targetId: s.targetId, stars, del, at },
            });
          } catch (e) {
            const m = String((e as Error).message);
            if (m.startsWith('REVISION_CONFLICT') || m.startsWith('SOURCE_GENERATION_CONFLICT')) throw new ActionError('STALE');
            throw e;
          }
          const r = res.results.find((x) => x.id === photoId);
          if (!r?.ok) throw new ActionError('MARK_FAILED');
          await this.#d.jobs.projectConfirmation(s.jobId, { photoId, sourceOpId: a.opId, by: a.actorId, stars, del, channel: 'feishu', at });
          return { photoId: mode === 'review' ? this.#step(s.jobId, photoId, 1, true) : this.#nextPhoto(s.jobId, photoId) };
        }
        // 浏览动作只移动光标，不写标记
        if (a.actionId === 'skip') return { photoId: mode === 'review' ? this.#step(s.jobId, s.photoId, 1, true) : this.#nextPhoto(s.jobId, s.photoId) };
        if (a.actionId === 'prev') return { photoId: this.#step(s.jobId, s.photoId, -1, mode === 'review') };
        if (a.actionId === 'refresh') return { photoId: s.photoId };
        if (a.actionId === 'review' || a.actionId === 'list') { mode = 'review'; return { photoId: this.#step(s.jobId, null, 1, true) }; }
        mode = 'confirm';
        return { photoId: this.#nextPhoto(s.jobId, null) };
      });
      outcome = { status: 'done' };
    } catch (e) {
      const code = e instanceof ActionError ? e.code : 'INTERNAL';
      outcome = { status: 'failed', code };
      // 旧版冲突：把卡片刷新到最新版本，便于重试
      if (code === 'STALE') next = { photoId: s.photoId };
    }
    this.#settle(a, outcome);
    if (next) await this.render(s, next.photoId, { mode }).catch(() => undefined);
    return outcome;
  }

  #settle(a: ActionIntent, o: ActionOutcome): ActionOutcome { this.#d.actions.settle(a.key, o); return o; }

  /** 下一张未确认的照片（从 after 之后循环找；全部确认返回 null） */
  #nextPhoto(jobId: string, after: string | null): string | null {
    const items = this.#d.jobs.get(jobId)?.items ?? [];
    const start = after ? items.findIndex((i) => i.id === after) + 1 : 0;
    for (let k = 0; k < items.length; k++) {
      const i = items[(start + k) % items.length]!;
      if (!i.confirmedAt && i.id !== after && this.#d.marks.markVersion(i.id)) return i.id;
    }
    return null;
  }

  /** 相邻照片（dir=±1）；onlyConfirmed=复核模式只走已确认的；不循环，越界返回 null（进度卡） */
  #step(jobId: string, from: string | null, dir: 1 | -1, onlyConfirmed: boolean): string | null {
    const items = this.#d.jobs.get(jobId)?.items ?? [];
    let k = from ? items.findIndex((i) => i.id === from) : dir === 1 ? -1 : items.length;
    for (k += dir; k >= 0 && k < items.length; k += dir) {
      const i = items[k]!;
      if ((!onlyConfirmed || i.confirmedAt) && this.#d.marks.markVersion(i.id)) return i.id;
    }
    return null;
  }

  /** 把目标的当前卡片推进到 photoId（null = 进度卡）；新 session，旧卡片按钮随之失效 */
  async render(from: Pick<CardSession, 'connectorId' | 'tenantId' | 'targetId' | 'jobId'>, photoId: string | null, opts: { mode?: 'confirm' | 'review'; fresh?: boolean } = {}): Promise<CardSession> {
    const v = photoId ? this.#d.marks.markVersion(photoId) : null;
    const prev = this.#d.cursors.get(from.jobId, from.targetId);
    // fresh：发新消息（过期/超出更新窗口的旧卡片不能再更新），旧 session 撤销
    if (opts.fresh && prev?.sessionId) this.#d.sessions.revoke(prev.sessionId);
    const cur = opts.fresh ? undefined : prev;
    const s = this.#d.sessions.create({
      kind: photoId ? 'photo-review' : 'progress', connectorId: from.connectorId, tenantId: from.tenantId, targetId: from.targetId,
      jobId: from.jobId, photoId, revision: v?.revision ?? null, generation: v?.generation ?? null, messageId: cur?.messageId ?? null,
      ...(opts.mode === 'review' ? { mode: 'review' as const } : {}),
    }, this.#now());
    const content: SemanticContent = photoId ? { type: 'photo-review', taskId: from.jobId, photoId } : { type: 'progress', taskId: from.jobId };
    const intentId = `card_${s.sessionId}`;
    const r = cur?.messageId
      ? await this.#d.update(from.connectorId, { targetId: from.targetId, intentId, messageId: cur.messageId, content, sessionId: s.sessionId })
      : await this.#d.send(from.connectorId, { targetId: from.targetId, intentId, content, sessionId: s.sessionId });
    const messageId = r.status === 'sent' ? r.messageId : cur?.messageId ?? null;
    if (messageId) this.#d.sessions.bindMessage(s.sessionId, messageId);
    this.#d.cursors.set({ jobId: from.jobId, targetId: from.targetId, photoId, messageId, sessionId: s.sessionId }, this.#now());
    return s;
  }

  /** 卡片解析（给 FeishuTransport.resolve）：按 session 与任务当前状态生成卡片模型 */
  async resolve(content: SemanticContent, sessionId?: string): Promise<CardModel | null> {
    if (content.type === 'test-card') return { title: 'FrameFlow 测试卡', lines: ['这是管理员手动发送的连接测试卡片，可以忽略。'] };
    if (content.type === 'file') return null;
    if (content.type === 'session-card') return this.#resolveMeta(sessionId);
    const job = this.#d.jobs.get(content.taskId);
    if (!job) return null;
    const sum = confirmationSummary(job, (id) => this.#d.marks.markVersion(id) !== null);
    const progress = sum ? `已确认 ${sum.confirmed}/${sum.total}${sum.blocked ? `，${sum.blocked} 张暂不可用` : ''}` : `共 ${job.items.length} 张`;
    if (content.type === 'task-entry') return { title: 'FrameFlow 批注任务', lines: ['有一批照片等待确认。', progress], sessionId, actions: [{ label: '开始确认', actionId: 'open', primary: true }] };
    if (content.type === 'progress') {
      const done = sum ? sum.remaining === 0 : job.state === 'done';
      return { title: done ? 'FrameFlow 批注完成' : 'FrameFlow 批注进度', lines: [progress], sessionId, actions: done ? [{ label: '查看/重新标记', actionId: 'review' }] : [{ label: '继续', actionId: 'open', primary: true }, { label: '复核已确认', actionId: 'review' }] };
    }
    const idx = job.items.findIndex((i) => i.id === content.photoId);
    if (idx < 0) return null;
    const item = job.items[idx]!;
    const review = sessionId ? this.#d.sessions.get(sessionId)?.mode === 'review' : false;
    return {
      title: `第 ${idx + 1}/${job.items.length} 张${item.confirmedAt ? '（已确认，可重新标记）' : ''}`,
      lines: [progress, ...(item.confirmedAt ? [`当前：${typeof item.stars === 'number' ? `${item.stars} 星` : '未评星'}${item.del ? '，已弃用' : ''}`] : []), ...(review ? ['复核模式：只浏览已确认的照片'] : [])],
      photoId: item.id, sessionId,
      reviewForm: { stars: typeof item.stars === 'number' ? item.stars : null, reject: item.del === true },
      actions: [{ label: '上一张', actionId: 'prev' }, { label: review ? '下一张' : '跳过', actionId: 'skip' }, { label: '刷新', actionId: 'refresh' }],
    };
  }

  #resolveMeta(sessionId?: string): CardModel | null {
    const s = sessionId ? this.#d.sessions.get(sessionId) : undefined;
    if (!s) return null;
    const kids = (s.children ?? []).map((c) => ({ label: c.label, actionId: c.actionId, sessionId: c.sessionId }));
    if (s.kind === 'help') {
      return { title: 'FrameFlow 帮助', sessionId, lines: ['「任务」列出投递到这里的任务', '「继续」打开最近一个未完成任务', '「新建」从允许的项目创建批注任务（需创建权限）'], actions: [{ label: '任务列表', actionId: 'list-page', primary: true }, { label: '新建任务', actionId: 'create' }] };
    }
    if (s.kind === 'task-list') {
      const total = this.#visibleJobs(s.connectorId, s.targetId).length;
      const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
      const nav = [...((s.page ?? 0) > 0 ? [{ label: '上一页', actionId: 'list-prev' }] : []), ...((s.page ?? 0) + 1 < pages ? [{ label: '下一页', actionId: 'list-page' }] : [])];
      return { title: 'FrameFlow 任务', sessionId, lines: [total ? `第 ${(s.page ?? 0) + 1}/${pages} 页，共 ${total} 个任务` : '这里还没有可见的任务'], actions: [...kids, ...nav] };
    }
    if (s.kind === 'create-project') return { title: '新建批注任务：选择项目', sessionId, lines: kids.length ? ['只列出你被允许在这里创建任务的项目。'] : ['没有可用项目。'], actions: kids };
    if (s.kind === 'create-preview') {
      const name = s.projectId ? this.#d.creation?.projectName(s.projectId) ?? s.projectId : '';
      const done = this.#d.actions.doneFor(s.sessionId, 'confirm-create');
      if (done) return { title: '批注任务已创建', sessionId, lines: [`项目「${name}」，${s.photoCount ?? 0} 张，入口卡片将发送到这里。`] };
      return { title: '确认创建批注任务', sessionId, lines: [`项目「${name}」`, `共 ${s.photoCount ?? 0} 张照片`, '目标：当前会话', '确认后才会创建并派发；预览不发送任何内容。'], actions: [{ label: '确认创建', actionId: 'confirm-create', primary: true }, { label: '取消', actionId: 'cancel-create' }] };
    }
    return null;
  }
}
