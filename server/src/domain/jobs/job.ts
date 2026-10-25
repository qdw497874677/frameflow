/** 任务模型：快照、事件、状态机与进度（见 docs/core-model.md §7）。持久化见 adapters/outbound/fs/jobs-store.ts。 */
import type { Selection } from '../selection.ts';

export type JobState = 'planned' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type JobItemStatus = 'planned' | 'done' | 'skipped' | 'failed';
export type JobEventType =
  | 'created'
  | 'dispatched'
  | 'inbound'
  | 'applied'
  | 'skipped'
  | 'conflict'
  | 'failed'
  | 'cancelled'
  | 'undone'
  | 'done'
  | 'note';

/** 变更前后值的描述（stars 整数 / del 布尔 / 状态字符串…），线格式与 JobEvent 的 from/to 一致 */
export type JobValue = string | number | boolean | null;

/** manifest 的一行：「这个单位被怎么处理了」；annotate 就是「这张被标成了什么」 */
export interface JobItem {
  id: string;
  displayName?: string;
  status: JobItemStatus;
  from?: string | null;
  to?: string | null;
  note?: string | null;
  stars?: number | null;
  del?: boolean | null;
  /** 回流幂等键（外部系统重发整批时用来去重） */
  clientRef?: string | null;
  at?: string | null;
  /** 明确确认（F23，仅 confirmationMode=explicit）：首次确认时刻/确认人；重标不改计数 */
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  /** 最近一次投影的 marks 操作 id */
  sourceOpId?: string | null;
}

/** 事件日志的一行（追加型，不回改；`seq` 单调递增，可当轮询游标） */
export interface JobEvent {
  seq: number;
  at: string;
  type: JobEventType;
  photoId?: string | null;
  from?: JobValue;
  to?: JobValue;
  by?: string | null;
  channel?: string | null;
  clientRef?: string | null;
  note?: string | null;
  /** 确认投影（F23）：对应 marks 事务 opId；同一 opId 只投影一次 */
  sourceOpId?: string | null;
}

/** 事件入参（seq/at 由存储补） */
export interface JobEventInput {
  type: JobEventType;
  photoId?: string | null;
  from?: JobValue;
  to?: JobValue;
  by?: string | null;
  channel?: string | null;
  clientRef?: string | null;
  note?: string | null;
  sourceOpId?: string | null;
  at?: string;
}

export interface Artifact {
  kind: 'file' | 'dir' | 'url' | 'message';
  path: string;
  bytes?: number;
}

export interface JobProgress {
  done: number;
  total: number;
}

export interface Job {
  id: string;
  kind: string;
  state: JobState;
  selection: Selection;
  params?: Record<string, unknown>;
  channel?: string | null;
  dispatchedAt?: string | null;
  progress: JobProgress;
  items: JobItem[];
  artifacts: Artifact[];
  error?: string | null;
  reversible: boolean;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** 确认式创建（F13）：稳定 requestId 与创建载荷指纹；旧随机 id 路径为空 */
  requestId?: string | null;
  requestFingerprint?: string | null;
  /** 确认模式（F23）：explicit = 按唯一照片的明确确认计数；缺省为旧语义（跳过也算处理） */
  confirmationMode?: 'explicit' | null;
}

/** 确认进度摘要（F23/F27）：仅 explicit 模式；跳过/失败不计入 confirmed */
export interface ConfirmationSummary {
  confirmed: number;
  remaining: number;
  blocked: number;
  total: number;
}

export function confirmationSummary(job: Job, accessible: (photoId: string) => boolean = () => true): ConfirmationSummary | null {
  if (job.confirmationMode !== 'explicit') return null;
  let confirmed = 0;
  let blocked = 0;
  for (const i of job.items) {
    if (i.confirmedAt) confirmed++;
    else if (!accessible(i.id)) blocked++;
  }
  // 失联项不减总数：仍在 total 里，只是暂时无法确认
  return { confirmed, remaining: job.items.length - confirmed - blocked, blocked, total: job.items.length };
}

/** 一次确认投影的入参（来自已提交的 marks 事务） */
export interface ConfirmationProjection {
  photoId: string;
  sourceOpId: string;
  by: string;
  stars: number;
  del: boolean;
  channel: string;
  at?: string;
}

/** 参数校验的一处问题（`validate` 返回；HTTP 层放进 Error.detail.problems） */
export interface JobProblem {
  field: string;
  message: string;
}

export type JobErrorCode = 'invalid' | 'notfound' | 'conflict' | 'forbidden';

/** 业务错误：带上「HTTP 层该映射成什么」的粗粒度语义（core 里不出现状态码） */
export class JobError extends Error {
  readonly code: JobErrorCode;
  readonly problems: JobProblem[] | undefined;

  constructor(code: JobErrorCode, message: string, problems?: JobProblem[]) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.problems = problems;
  }
}

/** 合法迁移表。`done/failed → cancelled` 只由 undo 走（撤销已完成的任务）。 */
const TRANSITIONS: Record<JobState, JobState[]> = {
  planned: ['queued', 'cancelled', 'failed', 'interrupted'],
  queued: ['running', 'cancelled', 'failed', 'interrupted'],
  running: ['done', 'failed', 'cancelled', 'interrupted'],
  done: ['cancelled'],
  failed: ['cancelled'],
  interrupted: ['running', 'queued', 'cancelled', 'failed'],
  cancelled: [],
};

export const canTransition = (from: JobState, to: JobState): boolean => TRANSITIONS[from].includes(to);

export function jobProgress(items: JobItem[]): JobProgress {
  return { done: items.filter((i) => i.status !== 'planned').length, total: items.length };
}

/** items 是否全部有终态（planned 之外都是终态） */
export function itemsSettled(items: JobItem[]): boolean {
  return items.every((i) => i.status !== 'planned');
}

/** 创建任务入参（id/createdAt/progress/artifacts 由存储补） */
export interface JobCreateRecord {
  kind: string;
  selection: Selection;
  params?: Record<string, unknown>;
  channel?: string | null;
  items: JobItem[];
  reversible: boolean;
  state?: JobState;
  by?: string | null;
  /** 预分配 jobId（确认式创建）；缺省随机 */
  id?: string;
  requestId?: string | null;
  requestFingerprint?: string | null;
  confirmationMode?: 'explicit' | null;
}
