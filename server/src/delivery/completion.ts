/**
 * 完成通知（F29）。
 * - 通知目标 = 确认时同意（notifyOnComplete=true）的那批目标：原确认的目标 + 勾选了通知的追加目标；
 *   之后改策略不会扩大范围（这里不读策略）。
 * - 每个完成代次（任务第几次进入 done）占独立分片序号段：同一代次+目标只记一份账，
 *   重复事件 / 重标（不再进入 done）不会重发；不同代次才是新通知。
 */
import type { AppendRecord, ConfirmationRecord } from './confirmations.ts';
import type { PreviewTarget } from './types.ts';

/** 完成通知分片序号段：派发分片从 0 开始，完成通知从这里开始，每代次一个 */
export const COMPLETION_PART_BASE = 1000;
export const completionPartIndex = (generation: number) => COMPLETION_PART_BASE + Math.max(1, Math.floor(generation));
export const isCompletionPart = (partIndex: number) => partIndex >= COMPLETION_PART_BASE;

export interface CompletionMessage {
  readonly kind: 'task.completed';
  readonly jobId: string;
  readonly generation: number;
  readonly photoCount: number;
  readonly alias: string | null;
}

export function completionTargets(base: ConfirmationRecord, appends: readonly AppendRecord[]): PreviewTarget[] {
  if (base.t !== 'accepted') return [];
  const out = new Map<string, PreviewTarget>();
  if (base.snapshot.params.notifyOnComplete) for (const t of base.snapshot.targets) out.set(`${t.connectorId}\u0000${t.targetId}`, t);
  for (const a of appends) if (a.notifyOnComplete) for (const t of a.targets) out.set(`${t.connectorId}\u0000${t.targetId}`, t);
  return [...out.values()];
}

export function completionMessage(base: ConfirmationRecord, generation: number): CompletionMessage {
  return { kind: 'task.completed', jobId: base.jobId, generation, photoCount: base.snapshot.photoIds.length, alias: base.snapshot.params.alias };
}
