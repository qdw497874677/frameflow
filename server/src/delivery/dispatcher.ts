/**
 * 外传调度（F16）：把已接受的确认接到 runner 上；查询与单目标重试。
 * 消息内容只含任务 id / 张数 / 别名 / 说明——**不含**范围链接 token 或任何 Secret。
 */
import type { ConfirmationRecord, ConfirmationStore } from './confirmations.ts';
import { targetsStillAllowed, type PreviewState } from './previews.ts';
import { DeliveryRunner, type Transport } from './runner.ts';
import type { DeliveryStore, PartView } from './store.ts';
import type { TargetRef } from './types.ts';

export interface DispatchMessage {
  readonly kind: 'task.dispatched';
  readonly jobId: string;
  readonly photoCount: number;
  readonly alias: string | null;
  readonly note: string | null;
}

export function partsOf(rec: ConfirmationRecord): DispatchMessage[] {
  return [{ kind: 'task.dispatched', jobId: rec.jobId, photoCount: rec.snapshot.photoIds.length, alias: rec.snapshot.params.alias, note: rec.snapshot.params.note }];
}

export type RetryError = 'JOB_NOT_FOUND' | 'TARGET_NOT_IN_JOB' | 'NOTHING_TO_RETRY' | 'DUPLICATE_RISK' | 'ATTEMPT_IN_FLIGHT';

export class DeliveryDispatcher {
  readonly runner: DeliveryRunner<DispatchMessage>;
  readonly #store: DeliveryStore;
  readonly #confirms: ConfirmationStore;
  readonly #running = new Set<Promise<unknown>>();

  constructor(o: { store: DeliveryStore; confirmations: ConfirmationStore; transport: Transport<DispatchMessage>; state: () => PreviewState; timeoutMs?: number }) {
    this.#store = o.store;
    this.#confirms = o.confirmations;
    this.runner = new DeliveryRunner({
      store: o.store, transport: o.transport, timeoutMs: o.timeoutMs,
      authorized: (t) => {
        const rec = this.#current;
        return rec !== null && targetsStillAllowed(o.state(), rec.snapshot.projectId, [t]) === null;
      },
    });
  }

  #current: ConfirmationRecord | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  /** 登记分片（同步，立即可查），后台串行发送 */
  start(rec: ConfirmationRecord, only?: TargetRef, retryUnknown = false): PartView[] {
    const targets = only ? [only] : rec.snapshot.targets;
    const parts = partsOf(rec);
    for (const t of targets) parts.forEach((_, i) => this.#store.ensure({ jobId: rec.jobId, connectorId: t.connectorId, targetId: t.targetId, partIndex: i }));
    const p = (this.#chain = this.#chain.then(async () => {
      this.#current = rec;
      try { await this.runner.run({ jobId: rec.jobId, targets, parts, retryUnknown }); } finally { this.#current = null; }
    }).catch(() => undefined));
    this.#running.add(p);
    void p.finally(() => this.#running.delete(p));
    return this.list(rec.jobId) ?? [];
  }

  list(jobId: string): PartView[] | null {
    if (!this.#confirms.byJob(jobId)) return null;
    return this.#store.listJob(jobId);
  }

  retry(jobId: string, t: TargetRef, acceptDuplicateRisk: boolean): { ok: true; items: PartView[] } | { ok: false; code: RetryError } {
    const rec = this.#confirms.byJob(jobId);
    if (!rec) return { ok: false, code: 'JOB_NOT_FOUND' };
    if (!rec.snapshot.targets.some((x) => x.connectorId === t.connectorId && x.targetId === t.targetId)) return { ok: false, code: 'TARGET_NOT_IN_JOB' };
    const views = this.#store.listJob(jobId).filter((v) => v.connectorId === t.connectorId && v.targetId === t.targetId);
    if (views.some((v) => this.runner.attemptInFlight(v) || v.state === 'sending')) return { ok: false, code: 'ATTEMPT_IN_FLIGHT' };
    const unknown = views.some((v) => v.state === 'unknown');
    if (unknown && !acceptDuplicateRisk) return { ok: false, code: 'DUPLICATE_RISK' };
    if (!views.some((v) => v.state === 'failed' || v.state === 'pending' || v.state === 'unknown')) return { ok: false, code: 'NOTHING_TO_RETRY' };
    return { ok: true, items: this.start(rec, t, acceptDuplicateRisk) };
  }

  async idle(): Promise<void> {
    while (this.#running.size) await Promise.all([...this.#running]);
  }
}
