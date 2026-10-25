/**
 * 外传执行（F15）：逐目标、逐分片按账本推进。
 * - 只发 pending / failed 分片；sent 跳过；unknown 不自动重发（可能已到达，需人工确认）。
 * - 每次发送前复核授权（authorized）；撤销 → failed: AUTHORIZATION_REVOKED，不调传输。
 * - 超时判为 unknown；传输迟到的结果仍按原 intentId 记账（迟到成功 → sent）。
 * - 一个目标失败不影响其他目标。
 */
import type { TargetRef } from './types.ts';
import type { DeliveryStore, PartKey, PartView } from './store.ts';

export interface SendRequest<P> extends PartKey { readonly intentId: string; readonly part: P }
export interface Transport<P> { send(req: SendRequest<P>): Promise<{ messageId: string }> }

export interface RunInput<P> {
  readonly jobId: string;
  readonly targets: readonly TargetRef[];
  readonly parts: readonly P[];
  /** 显式接受重复外传风险时，unknown 分片也重发（F16 单目标重试） */
  readonly retryUnknown?: boolean;
}

export interface RunnerOptions<P> {
  readonly store: DeliveryStore;
  readonly transport: Transport<P>;
  readonly authorized: (t: TargetRef) => boolean;
  readonly timeoutMs?: number;
}

export class DeliveryRunner<P> {
  readonly #o: RunnerOptions<P>;
  /** 迟到结果的记账 promise（测试/关停时可等待） */
  readonly late = new Set<Promise<void>>();
  /** 超时后传输仍未返回的分片 */
  readonly inFlight = new Set<string>();

  attemptInFlight(key: PartKey): boolean { return this.inFlight.has(kOf(key)); }

  constructor(o: RunnerOptions<P>) { this.#o = o; }

  async run(input: RunInput<P>): Promise<PartView[]> {
    const { store } = this.#o;
    for (const t of input.targets) input.parts.forEach((_, i) => store.ensure({ jobId: input.jobId, ...pick(t), partIndex: i }));
    for (const t of input.targets) {
      for (let i = 0; i < input.parts.length; i++) {
        const key: PartKey = { jobId: input.jobId, ...pick(t), partIndex: i };
        const v = store.view(key)!;
        if (v.state !== 'pending' && v.state !== 'failed' && !(input.retryUnknown && v.state === 'unknown')) continue;
        if (this.inFlight.has(kOf(key))) break; // 原尝试未结束：不叠发
        const intentId = store.beginIntent(key);
        if (!this.#o.authorized(t)) { store.settle(key, intentId, 'failed', { error: 'AUTHORIZATION_REVOKED' }); break; }
        const ok = await this.#sendOne(key, intentId, input.parts[i]!);
        if (!ok) break; // 分片有序：本目标后续分片等下次重试
      }
    }
    return store.listJob(input.jobId);
  }

  async #sendOne(key: PartKey, intentId: string, part: P): Promise<boolean> {
    const { store, transport, timeoutMs = 30_000 } = this.#o;
    const p = transport.send({ ...key, intentId, part });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
    try {
      const r = await Promise.race([p, timeout]);
      if (r === 'timeout') {
        store.settle(key, intentId, 'unknown', { error: 'TIMEOUT' });
        const lateRec = p.then((x) => store.settle(key, intentId, 'sent', { messageId: x.messageId }), () => { /* 迟到失败：保持 unknown */ });
        this.late.add(lateRec);
        this.inFlight.add(kOf(key));
        void lateRec.finally(() => { this.late.delete(lateRec); this.inFlight.delete(kOf(key)); });
        return false;
      }
      store.settle(key, intentId, 'sent', { messageId: r.messageId });
      return true;
    } catch (e) {
      store.settle(key, intentId, 'failed', { error: e instanceof Error ? e.message.slice(0, 200) : 'SEND_FAILED' });
      return false;
    } finally { clearTimeout(timer); }
  }
}

function pick(t: TargetRef): { connectorId: string; targetId: string } { return { connectorId: t.connectorId, targetId: t.targetId }; }

function kOf(k: PartKey): string { return `${k.jobId}\u0000${k.connectorId}\u0000${k.targetId}\u0000${k.partIndex}`; }
