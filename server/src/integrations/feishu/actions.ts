/**
 * 动作意图日志（F22/F24）：以 (sessionId, actionId, 实际操作者) 为键。
 * - 先可靠落盘（fsync）为 accepted，才回「处理中」；处理完追加 done/failed。
 * - 同键同载荷 → 重放（不再处理）；同键异载荷 → ACTION_CONFLICT。
 * - opId = hash(sessionId, actionId, actor)，绝不以星级值做永久 key。
 * - 待处理数超过上限 → OVERLOADED（拒绝，不受理）。
 * - 重启：仍为 accepted 的动作由控制器 pending() 取出重新处理（同 opId 由 marks 重放）。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { JsonlLog } from './jsonl.ts';

export interface ActionIntent {
  readonly key: string;
  readonly opId: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly actorId: string;
  readonly payloadHash: string;
  readonly payload: Record<string, unknown>;
  readonly source: { kind: string; externalId: string } | null;
  readonly messageId: string | null;
  readonly at: number;
}

export type ActionOutcome = { readonly status: 'done' | 'failed'; readonly code?: string };

type Row = { t: 'accepted'; a: ActionIntent } | { t: 'settled'; key: string; outcome: ActionOutcome };

const h = (s: string) => createHash('sha256').update(s).digest('hex');
export const actionKey = (sessionId: string, actionId: string, actorId: string) => JSON.stringify([sessionId, actionId, actorId]);
export const actionOpId = (sessionId: string, actionId: string, actorId: string) => `fs_${h(actionKey(sessionId, actionId, actorId)).slice(0, 40)}`;

function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export type AcceptResult =
  | { kind: 'new'; intent: ActionIntent }
  | { kind: 'replay'; intent: ActionIntent; outcome: ActionOutcome | null }
  | { kind: 'rejected'; code: 'ACTION_CONFLICT' | 'OVERLOADED' };

export class ActionLog {
  readonly #log: JsonlLog<Row>;
  readonly #intents = new Map<string, ActionIntent>();
  readonly #outcomes = new Map<string, ActionOutcome>();
  readonly maxPending: number;

  constructor(dataDir: string, maxPending = 64) {
    this.maxPending = maxPending;
    this.#log = new JsonlLog<Row>(path.join(dataDir, 'feishu', 'actions.jsonl'));
    for (const r of this.#log.load()) {
      if (r.t === 'accepted') this.#intents.set(r.a.key, r.a);
      else this.#outcomes.set(r.key, r.outcome);
    }
  }

  pending(): ActionIntent[] { return [...this.#intents.values()].filter((a) => !this.#outcomes.has(a.key)); }

  accept(input: Omit<ActionIntent, 'key' | 'opId' | 'payloadHash' | 'at'>, now = Date.now()): AcceptResult {
    const key = actionKey(input.sessionId, input.actionId, input.actorId);
    const payloadHash = h(canon(input.payload));
    const prev = this.#intents.get(key);
    if (prev) return prev.payloadHash === payloadHash ? { kind: 'replay', intent: prev, outcome: this.#outcomes.get(key) ?? null } : { kind: 'rejected', code: 'ACTION_CONFLICT' };
    if (this.pending().length >= this.maxPending) return { kind: 'rejected', code: 'OVERLOADED' };
    const intent: ActionIntent = { ...input, key, payloadHash, opId: actionOpId(input.sessionId, input.actionId, input.actorId), at: now };
    this.#log.append({ t: 'accepted', a: intent });
    this.#intents.set(key, intent);
    return { kind: 'new', intent };
  }

  settle(key: string, outcome: ActionOutcome): void {
    if (this.#outcomes.has(key)) return;
    this.#log.append({ t: 'settled', key, outcome });
    this.#outcomes.set(key, outcome);
  }

  outcome(key: string): ActionOutcome | undefined { return this.#outcomes.get(key); }
}
