/**
 * 外传账本（F15）：deliveries.jsonl，按「目标 × 分片」追加意图与结果。
 *
 * 状态：pending → sending → sent | failed | unknown
 * - 发送前**先**写 sending（带新 intentId，fsync），再调传输。
 * - 重启时残留的 sending 收敛为 unknown（可能已发出，不自动重发，防重复外传）。
 * - 结果按 intentId 记账：迟到的成功归属它自己的意图；分片只要有一个意图 sent 即为 sent。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export type PartState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';

export interface PartKey {
  readonly jobId: string;
  readonly connectorId: string;
  readonly targetId: string;
  readonly partIndex: number;
}

export interface LedgerLine extends PartKey {
  readonly t: 'part';
  readonly state: PartState;
  readonly intentId: string | null;
  readonly at: string;
  readonly messageId?: string;
  readonly error?: string;
}

export interface PartView extends PartKey {
  readonly state: PartState;
  readonly attempts: number;
  readonly currentIntentId: string | null;
  readonly messageId: string | null;
  readonly error: string | null;
}

interface Mut { key: PartKey; intents: Map<string, LedgerLine>; current: string | null; base: LedgerLine | null }

const k = (p: PartKey) => `${p.jobId}\u0000${p.connectorId}\u0000${p.targetId}\u0000${p.partIndex}`;

export class DeliveryStore {
  readonly file: string;
  readonly #parts = new Map<string, Mut>();
  readonly #now: () => number;

  private constructor(file: string, now: () => number) { this.file = file; this.#now = now; }

  static open(dataDir: string, now: () => number = Date.now): DeliveryStore {
    fs.mkdirSync(dataDir, { recursive: true });
    const s = new DeliveryStore(path.join(dataDir, 'deliveries.jsonl'), now);
    let text = '';
    try { text = fs.readFileSync(s.file, 'utf8'); } catch { /* 首次 */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as LedgerLine; if (r.t === 'part') s.#apply(r); } catch { /* 半行 */ }
    }
    // 重启收敛：没有结果的 sending → unknown
    for (const m of s.#parts.values()) {
      for (const [id, l] of m.intents) if (l.state === 'sending') s.#write({ ...m.key, t: 'part', state: 'unknown', intentId: id, at: s.#iso(), error: 'RESTART_WHILE_SENDING' });
    }
    return s;
  }

  #iso(): string { return new Date(this.#now()).toISOString(); }

  #apply(r: LedgerLine): void {
    const key: PartKey = { jobId: r.jobId, connectorId: r.connectorId, targetId: r.targetId, partIndex: r.partIndex };
    let m = this.#parts.get(k(key));
    if (!m) { m = { key, intents: new Map(), current: null, base: null }; this.#parts.set(k(key), m); }
    if (r.intentId === null) { m.base = r; return; }
    if (r.state === 'sending' && !m.intents.has(r.intentId)) m.current = r.intentId;
    const prev = m.intents.get(r.intentId);
    // sent 是终态：一个意图一旦 sent，后来的 unknown/failed（比如超时判定）不覆盖它
    if (prev?.state === 'sent') return;
    m.intents.set(r.intentId, r);
  }

  #write(r: LedgerLine): void {
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(r)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.#apply(r);
  }

  /** 登记分片（幂等）：已存在的不动 */
  ensure(key: PartKey): void {
    if (!this.#parts.has(k(key))) this.#write({ ...key, t: 'part', state: 'pending', intentId: null, at: this.#iso() });
  }

  /** 写发送意图；返回 intentId */
  beginIntent(key: PartKey): string {
    const intentId = `in_${randomUUID().replace(/-/g, '')}`;
    this.#write({ ...key, t: 'part', state: 'sending', intentId, at: this.#iso() });
    return intentId;
  }

  /** 记某意图的结果（迟到的也归属原意图） */
  settle(key: PartKey, intentId: string, state: 'sent' | 'failed' | 'unknown', extra: { messageId?: string; error?: string } = {}): void {
    if (!this.#parts.get(k(key))?.intents.has(intentId)) throw new Error(`未知意图：${intentId}`);
    this.#write({ ...key, t: 'part', state, intentId, at: this.#iso(), ...extra });
  }

  view(key: PartKey): PartView | undefined {
    const m = this.#parts.get(k(key));
    if (!m) return undefined;
    const intents = [...m.intents.values()];
    const sent = intents.find((l) => l.state === 'sent');
    const cur = m.current ? m.intents.get(m.current) : undefined;
    const state: PartState = sent ? 'sent' : (cur?.state ?? 'pending');
    return { ...m.key, state, attempts: m.intents.size, currentIntentId: m.current, messageId: sent?.messageId ?? null, error: sent ? null : (cur?.error ?? null) };
  }

  intentState(key: PartKey, intentId: string): PartState | undefined {
    return this.#parts.get(k(key))?.intents.get(intentId)?.state;
  }

  listJob(jobId: string): PartView[] {
    return [...this.#parts.values()].filter((m) => m.key.jobId === jobId).map((m) => this.view(m.key)!)
      .sort((a, b) => a.connectorId.localeCompare(b.connectorId) || a.targetId.localeCompare(b.targetId) || a.partIndex - b.partIndex);
  }
}
