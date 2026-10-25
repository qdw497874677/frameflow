/**
 * 外传调度（F16）：把已接受的确认接到 runner 上；查询与单目标重试。
 * 消息内容只含任务 id / 张数 / 别名 / 说明——**不含**范围链接 token 或任何 Secret。
 */
import type { AppendRecord, ConfirmationRecord } from '../../domain/delivery/confirmation.ts';
import type { PartView } from '../../domain/delivery/ledger.ts';
import type { ConfirmationLog, DeliveryLedger } from './ports.ts';
import { completionMessage, completionPartIndex, completionTargets, type CompletionMessage } from '../../domain/delivery/completion.ts';
import { targetsStillAllowed, type PreviewState } from './previews.ts';
import { DeliveryRunner, type Transport } from './runner.ts';
import type { TargetRef } from '../../domain/delivery/types.ts';

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

/** 运行时消息：派发入口或完成通知 */
export type DeliveryMessage = DispatchMessage | CompletionMessage;

export type RetryError = 'JOB_NOT_FOUND' | 'TARGET_NOT_IN_JOB' | 'NOTHING_TO_RETRY' | 'DUPLICATE_RISK' | 'ATTEMPT_IN_FLIGHT';

export class DeliveryDispatcher {
  readonly runner: DeliveryRunner<DeliveryMessage>;
  readonly #store: DeliveryLedger;
  readonly #confirms: ConfirmationLog;
  readonly #running = new Set<Promise<unknown>>();

  constructor(o: { store: DeliveryLedger; confirmations: ConfirmationLog; transport: Transport<DeliveryMessage>; state: () => PreviewState; timeoutMs?: number }) {
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
    return this.#enqueue(rec, only ? [only] : rec.snapshot.targets, partsOf(rec), 0, retryUnknown);
  }

  /** F29a：追加目标只给新增目标发派发入口；旧目标（含已成功的）不动 */
  startAppend(app: AppendRecord): PartView[] {
    const base = this.#confirms.byJob(app.jobId);
    if (!base || base.t !== 'accepted') return [];
    return this.#enqueue(base, app.targets, partsOf(base), 0, false);
  }

  /** F29：完成通知。同代次+目标只一份账（已 sent/unknown 不再发）；目标仅限确认时同意通知的 */
  notifyCompleted(jobId: string, generation: number): PartView[] {
    const base = this.#confirms.byJob(jobId);
    if (!base || base.t !== 'accepted') return [];
    const targets = completionTargets(base, this.#confirms.appendsOf(jobId));
    if (!targets.length) return this.list(jobId) ?? [];
    const idx = completionPartIndex(generation);
    const fresh = targets.filter((t) => this.#store.view({ jobId, connectorId: t.connectorId, targetId: t.targetId, partIndex: idx }) === undefined);
    if (!fresh.length) return this.list(jobId) ?? [];
    return this.#enqueue(base, fresh, [completionMessage(base, generation)], idx, false);
  }

  #enqueue(rec: ConfirmationRecord, targets: readonly TargetRef[], parts: DeliveryMessage[], partOffset: number, retryUnknown: boolean): PartView[] {
    if (this.#store.corrupt) return this.list(rec.jobId) ?? []; // F31：账本损坏 → 只读，不建分片、不外传
    for (const t of targets) parts.forEach((_, i) => this.#store.ensure({ jobId: rec.jobId, connectorId: t.connectorId, targetId: t.targetId, partIndex: partOffset + i }));
    const p = (this.#chain = this.#chain.then(async () => {
      this.#current = rec;
      try { await this.runner.run({ jobId: rec.jobId, targets, parts, retryUnknown, partOffset }); } finally { this.#current = null; }
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
    if (!this.#confirms.targetsOf(jobId).some((x) => x.connectorId === t.connectorId && x.targetId === t.targetId)) return { ok: false, code: 'TARGET_NOT_IN_JOB' };
    // 重试只针对派发入口分片（完成通知按代次独立，不随手动重试重发）
    const views = this.#store.listJob(jobId).filter((v) => v.connectorId === t.connectorId && v.targetId === t.targetId && v.partIndex < 1000);
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
