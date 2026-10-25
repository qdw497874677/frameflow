/**
 * 卡片 session（F22）：每张交互卡片绑定一个不透明 sessionId，服务端记录它属于哪个
 * 实例/租户/目标/消息/任务/照片/版本与期限。按钮 value 只带 sessionId+actionId，其余一律以此为准。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { JsonlLog } from './jsonl.ts';

export type SessionKind = 'task-entry' | 'photo-review' | 'progress';

export interface CardSession {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly connectorId: string;
  readonly tenantId: string;
  readonly targetId: string;
  readonly jobId: string;
  readonly photoId: string | null;
  /** 渲染时照片标记版本 / 源版本（确认时作 expectedRevisions/Generations） */
  readonly revision: number | null;
  readonly generation: string | null;
  readonly expiresAt: number;
  readonly messageId: string | null;
  readonly createdAt: number;
}

type Row = { t: 'session'; s: CardSession } | { t: 'message'; sessionId: string; messageId: string };

export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

export class SessionStore {
  readonly #log: JsonlLog<Row>;
  readonly #byId = new Map<string, CardSession>();

  constructor(dataDir: string) {
    this.#log = new JsonlLog<Row>(path.join(dataDir, 'feishu', 'sessions.jsonl'));
    for (const r of this.#log.load()) this.#apply(r);
  }

  #apply(r: Row): void {
    if (r.t === 'session') this.#byId.set(r.s.sessionId, r.s);
    else { const s = this.#byId.get(r.sessionId); if (s) this.#byId.set(s.sessionId, { ...s, messageId: r.messageId }); }
  }

  create(init: Omit<CardSession, 'sessionId' | 'expiresAt' | 'createdAt' | 'messageId'> & { messageId?: string | null }, now = Date.now()): CardSession {
    const s: CardSession = { ...init, messageId: init.messageId ?? null, sessionId: `s_${randomBytes(12).toString('base64url')}`, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    const row: Row = { t: 'session', s };
    this.#log.append(row);
    this.#apply(row);
    return s;
  }

  bindMessage(sessionId: string, messageId: string): void {
    const s = this.#byId.get(sessionId);
    if (!s || s.messageId === messageId) return;
    const row: Row = { t: 'message', sessionId, messageId };
    this.#log.append(row);
    this.#apply(row);
  }

  get(sessionId: string): CardSession | undefined { return this.#byId.get(sessionId); }

  /**
   * 校验事件与 session 绑定一致：实例、租户、来源目标、消息（转发卡片 messageId 不同 → 拒绝）与期限。
   */
  check(sessionId: unknown, ev: { connectorId: string; tenantId: string; targetId: string | null; messageId?: string }, now = Date.now()):
    { ok: true; session: CardSession } | { ok: false; code: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_MISMATCH' } {
    const s = typeof sessionId === 'string' ? this.#byId.get(sessionId) : undefined;
    if (!s) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (now >= s.expiresAt) return { ok: false, code: 'SESSION_EXPIRED' };
    if (s.connectorId !== ev.connectorId || s.tenantId !== ev.tenantId || s.targetId !== ev.targetId) return { ok: false, code: 'SESSION_MISMATCH' };
    if (s.messageId && ev.messageId && s.messageId !== ev.messageId) return { ok: false, code: 'SESSION_MISMATCH' };
    return { ok: true, session: s };
  }
}
