/**
 * 确认投影对账（F23）：marks 事务已提交、任务投影尚未写入（崩溃在两步之间）时，
 * 从 marks 日志的 confirmation 元数据补投影；已投影的 sourceOpId 跳过，不重复事件/计数，不重写标记。
 */
import type { ConfirmationProjection, Job } from '../../domain/jobs/job.ts';
import type { MarkTransactionResult } from '../../domain/marks.ts';

export interface ReconcileDeps {
  confirmedOps(jobId: string): Array<{ opId: string; confirmation: Record<string, unknown>; result: MarkTransactionResult }>;
  hasProjected(jobId: string, opId: string): boolean;
  projectConfirmation(jobId: string, p: ConfirmationProjection): Promise<unknown>;
  get(jobId: string): Job | undefined;
}

export async function reconcileConfirmations(d: ReconcileDeps, jobId: string): Promise<number> {
  const job = d.get(jobId);
  if (!job || job.confirmationMode !== 'explicit') return 0;
  let n = 0;
  for (const op of d.confirmedOps(jobId)) {
    if (d.hasProjected(jobId, op.opId)) continue;
    const c = op.confirmation;
    const photoId = String(c['photoId'] ?? '');
    const r = op.result.results.find((x) => x.id === photoId);
    if (!r?.ok) continue;
    await d.projectConfirmation(jobId, {
      photoId, sourceOpId: op.opId, by: String(c['actorId'] ?? ''), stars: Number(r.stars ?? c['stars'] ?? 0), del: Boolean(r.del ?? c['del']),
      channel: 'feishu', ...(typeof c['at'] === 'string' ? { at: c['at'] } : {}),
    });
    n++;
  }
  return n;
}
