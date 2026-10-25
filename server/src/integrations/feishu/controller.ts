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
}

/** 动作 → 所需授权 */
const OPERATION: Record<string, ConnectorOperation> = { open: 'viewTask', skip: 'viewTask', refresh: 'viewTask', submit: 'annotate', remark: 'annotate', list: 'viewTask', reopen: 'viewTask' };
const CLOSED = new Set(['cancelled', 'failed', 'planned']);

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export class FeishuController {
  readonly #d: ControllerDeps;
  /** 后台处理（测试/关停等待） */
  readonly background = new Set<Promise<unknown>>();

  constructor(deps: ControllerDeps) { this.#d = deps; }

  #now(): number { return (this.#d.now ?? Date.now)(); }

  /** 连接器事件入口（ConnectorRuntime onEvent） */
  async handle(connectorId: string, ev: ConnectorEvent): Promise<EventAck> {
    const p = ev.payload;
    if (p['type'] !== 'card-action') return { kind: 'rejected', code: 'UNSUPPORTED_EVENT' };
    const actionId = typeof p['actionId'] === 'string' ? p['actionId'] : '';
    if (!OPERATION[actionId]) return { kind: 'rejected', code: 'ACTION_UNKNOWN' };
    const inst = this.#d.config().instances.find((i) => i.id === connectorId);
    const target = inst && ev.source ? findSourceTarget(inst, ev.source) : undefined;
    const chk = this.#d.sessions.check(p['sessionId'], { connectorId, tenantId: ev.identity.tenantId, targetId: target?.id ?? null, messageId: ev.messageId }, this.#now());
    if (!chk.ok) return { kind: 'rejected', code: chk.code, toast: chk.code === 'SESSION_EXPIRED' ? '卡片已过期，请重新打开任务' : '这张卡片不能在这里操作' };
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

  #spawn(a: ActionIntent): void {
    const run = this.process(a).catch(() => undefined).finally(() => this.background.delete(run));
    this.background.add(run);
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
          return { photoId: this.#nextPhoto(s.jobId, photoId) };
        }
        if (a.actionId === 'skip') return { photoId: this.#nextPhoto(s.jobId, s.photoId) };
        if (a.actionId === 'refresh') return { photoId: s.photoId };
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
    if (next) await this.render(s, next.photoId).catch(() => undefined);
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

  /** 把目标的当前卡片推进到 photoId（null = 进度卡）；新 session，旧卡片按钮随之失效 */
  async render(from: Pick<CardSession, 'connectorId' | 'tenantId' | 'targetId' | 'jobId'>, photoId: string | null): Promise<CardSession> {
    const v = photoId ? this.#d.marks.markVersion(photoId) : null;
    const cur = this.#d.cursors.get(from.jobId, from.targetId);
    const s = this.#d.sessions.create({
      kind: photoId ? 'photo-review' : 'progress', connectorId: from.connectorId, tenantId: from.tenantId, targetId: from.targetId,
      jobId: from.jobId, photoId, revision: v?.revision ?? null, generation: v?.generation ?? null, messageId: cur?.messageId ?? null,
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
    const job = this.#d.jobs.get(content.taskId);
    if (!job) return null;
    const sum = confirmationSummary(job, (id) => this.#d.marks.markVersion(id) !== null);
    const progress = sum ? `已确认 ${sum.confirmed}/${sum.total}${sum.blocked ? `，${sum.blocked} 张暂不可用` : ''}` : `共 ${job.items.length} 张`;
    if (content.type === 'task-entry') return { title: 'FrameFlow 批注任务', lines: ['有一批照片等待确认。', progress], sessionId, actions: [{ label: '开始确认', actionId: 'open', primary: true }] };
    if (content.type === 'progress') {
      const done = sum ? sum.remaining === 0 : job.state === 'done';
      return { title: done ? 'FrameFlow 批注完成' : 'FrameFlow 批注进度', lines: [progress], sessionId, actions: done ? [{ label: '查看/重新标记', actionId: 'list' }] : [{ label: '继续', actionId: 'open', primary: true }] };
    }
    const idx = job.items.findIndex((i) => i.id === content.photoId);
    if (idx < 0) return null;
    const item = job.items[idx]!;
    return {
      title: `第 ${idx + 1}/${job.items.length} 张${item.confirmedAt ? '（已确认，可重新标记）' : ''}`,
      lines: [progress], photoId: item.id, sessionId,
      reviewForm: { stars: typeof item.stars === 'number' ? item.stars : null, reject: item.del === true },
      actions: [{ label: '跳过', actionId: 'skip' }, { label: '刷新', actionId: 'refresh' }],
    };
  }
}
