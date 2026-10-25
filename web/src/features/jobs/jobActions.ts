import type { Job } from '../../core/types';

/**
 * 任务详情页该给哪些操作、进度怎么显示。
 * - 取消：只对还在跑的任务显示；已收尾（完成/失败/取消）直接不显示，而不是灰着留在那儿。
 * - 撤销：可撤销且还没撤过才显示（服务端允许撤销已取消任务写下的标注，所以取消后仍可撤）。
 * - 批注链接：任务取消/失败后链接已失效，不再给复制/打开。
 * - 进度：撤销后标注已回滚，进度条归零，并注明原进度。
 */
export function jobActions(job: Pick<Job, 'state' | 'reversible' | 'progress'>, undone: boolean) {
  const ended = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
  const done = undone ? 0 : job.progress.done;
  return {
    canCancel: !ended,
    canUndo: Boolean(job.reversible) && !undone,
    linkUsable: job.state !== 'cancelled' && job.state !== 'failed',
    progress: {
      done,
      total: job.progress.total,
      percent: job.progress.total ? Math.round((done / job.progress.total) * 100) : 0,
      label: undone ? `已撤销（原进度 ${job.progress.done}/${job.progress.total}）` : `${job.progress.done}/${job.progress.total}`,
    },
  };
}
