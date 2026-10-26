import type { Job } from '../../core/types';

/**
 * 任务详情页该给哪些操作、进度怎么显示。
 * - 取消：只对还在跑的任务显示；已收尾（完成/失败/取消）直接不显示，而不是灰着留在那儿。
 * - 撤销：可撤销且还没撤过才显示（服务端允许撤销已取消任务写下的标注，所以取消后仍可撤）。
 * - 批注链接：任务取消/失败后链接已失效，不再给复制/打开。
 * - 进度：撤销后标注已回滚，进度条归零，并注明原进度。
 */
/**
 * 任务进度的唯一口径：侧栏列表与详情页都用这一个（之前两处各算各的）。
 * 显式确认任务按「已确认」计；撤销后归零并注明原进度。
 */
export function jobProgressView(job: Pick<Job, 'progress' | 'confirmation'>, undone = false) {
  const base = job.confirmation ? { done: job.confirmation.confirmed, total: job.confirmation.total } : job.progress;
  const done = undone ? 0 : base.done;
  const text = `${job.confirmation ? '已确认 ' : ''}${base.done}/${base.total}`;
  return {
    done,
    total: base.total,
    percent: base.total ? Math.round((done / base.total) * 100) : 0,
    label: undone ? `已撤销（原进度 ${text}）` : text,
  };
}

export function jobActions(job: Pick<Job, 'state' | 'reversible' | 'progress' | 'confirmation'>, undone: boolean) {
  const ended = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
  return {
    canCancel: !ended,
    canUndo: Boolean(job.reversible) && !undone,
    linkUsable: job.state !== 'cancelled' && job.state !== 'failed',
    progress: jobProgressView(job, undone),
  };
}
