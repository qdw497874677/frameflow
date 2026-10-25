/**
 * 任务能力注册表：一个 kind 一个文件（`jobs/<kind>.ts`），这里汇总成一张表 ——
 * `GET /capabilities` 的 `jobs` 就是它的投影，`POST /jobs` 的 `kind` 必须在这里查到（否则 400）。
 *
 * 约定（见 server/README.md 的模块边界）：
 *  - handler **只依赖 `core/`**（扫描结果、标注、选择集求值…），不 import 别的 handler、不 import `api/`；
 *  - 要签发链接、要写任务字段，都通过 `plan/apply/inbound/undo` 拿到的 `ctx`/`sink` ——
 *    HTTP 语义（状态码）不出现在这里，`JobError.code` 由 api/server.ts 映射。
 *  - 一个 kind 的 handler 只描述「这个任务怎么办」，任务状态机与事件日志在 core/jobs.ts、jobs/service.ts。
 */

import type { Job, JobEventInput, JobItem, JobProblem } from '../../domain/jobs/job.ts';
import type { Library } from '../library.ts';
import type { MarkResultDto } from '../../domain/marks.ts';
import type { Selection } from '../../domain/selection.ts';
import { annotate } from './annotate.ts';

/** handler 拿到的东西：库（读照片/写标注）+ 任务层给的能力 */
export interface JobContext {
  lib: Library;
  /** 签发任务范围 token（载荷 `annotate|<jobId>|<批注人>|<exp>|<签发它的 API token id>`），见 api/auth.ts */
  signRangeToken: (jobId: string, alias: string, tokenId?: string | null) => { token: string; expiresAt: string };
  /** F29：任务进入 done 时回调（完成通知；generation = 第几次完成） */
  onDone?: (job: Job, generation: number) => void;
}

/** 外部回流的原始一项（`by` 由凭据推出来，不由请求体决定） */
export interface InboundInput {
  photoId: string;
  stars?: number;
  del?: boolean;
  at?: string;
  clientRef?: string;
}

/** 进 handler 的项：`by` 已经由凭据解析好（范围 token → `link:<批注人>`，主凭据 → `me`） */
export interface InboundWrite extends InboundInput {
  by: string;
}

/** 回执：写盘的逐项结果（HTTP 响应体里的 `results`） */
export interface InboundOutcome {
  results: MarkResultDto[];
}

export interface JobDraft {
  kind: string;
  selection: Selection;
  params: Record<string, unknown>;
}

/** `apply` / `inbound` / `undo` 的收尾话术：状态机只认这些词，字段级细节已经通过 sink 落了 */
export interface JobOutcome {
  state?: 'running' | 'done' | 'failed';
  error?: string | null;
  note?: string | null;
  /** `inbound` 用来把逐项结果交给 HTTP 层 */
  results?: MarkResultDto[];
}

/** 任务执行者往任务里写东西的入口（都由 jobs/service.ts 接在 core/jobs.ts 上）*/
export interface JobSink {
  jobId: string;
  event: (ev: JobEventInput) => void;
  item: (itemId: string, patch: Partial<JobItem>) => void;
  artifact: (artifact: { kind: 'file' | 'dir' | 'url' | 'message'; path: string; bytes?: number }) => void;
  patch: (patch: Partial<Job>) => void;
  progress: () => { done: number; total: number };
}

export interface JobHandler {
  kind: string;
  /** 一句话人话标签（`/capabilities` 里给 UI 用） */
  label: string;
  /** 这个 kind 的 params 自描述（给 UI / AI 看，不做运行时校验） */
  params: Record<string, unknown>;
  /** 这个任务有没有副作用（写标注 / 动磁盘），还是纯读 */
  sideEffect: 'read' | 'mark' | 'file';
  /** 能不能 undo */
  undoable: boolean;
  needsNetwork: boolean;
  validate: (draft: JobDraft, ctx: JobContext) => JobProblem[];
  plan: (draft: JobDraft, ctx: JobContext) => JobItem[] | Promise<JobItem[]>;
  apply: (job: Job, ctx: JobContext, sink: JobSink) => JobOutcome | Promise<JobOutcome>;
  /** 外部回流（`POST /jobs/{id}/inbound`）；不支持回流的 kind 不实现 */
  inbound?: (job: Job, items: InboundWrite[], ctx: JobContext, sink: JobSink) => InboundOutcome | Promise<InboundOutcome>;
  undo?: (job: Job, ctx: JobContext, sink: JobSink) => JobOutcome | Promise<JobOutcome>;
}

/** 注册表：v1 只有 annotate */
export const registry: Record<string, JobHandler> = {
  [annotate.kind]: annotate,
};

export function getHandler(kind: string): JobHandler | undefined {
  return registry[kind];
}

export function jobKinds(): string[] {
  return Object.keys(registry).sort();
}
