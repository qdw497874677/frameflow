/** 任务用例依赖的出站端口；实现见 adapters/outbound/fs/jobs-store.ts。 */
import type {
  Artifact, ConfirmationProjection, Job, JobCreateRecord, JobEvent, JobEventInput, JobEventType, JobItem, JobState,
} from '../../domain/jobs/job.ts';

/** 任务快照 + 事件流水；非法状态迁移抛 JobError('conflict') */
export interface JobsRepository {
  get(id: string): Job | undefined;
  list(opts?: { state?: string; limit?: number }): Job[];
  events(id: string, opts?: { since?: number; limit?: number }): { items: JobEvent[]; nextSince: number };
  hasItem(id: string, photoId: string): boolean;
  byRequestId(requestId: string): Job | undefined;
  hasEvent(id: string, type: JobEventType): boolean;
  create(input: JobCreateRecord): Job;
  setState(id: string, next: JobState, opts?: { error?: string | null; at?: string }): Job;
  patch(id: string, patch: Partial<Job>): Job;
  updateItem(id: string, itemId: string, patch: Partial<JobItem>): JobItem | null;
  addArtifact(id: string, artifact: Artifact): Job;
  hasProjected(id: string, sourceOpId: string): boolean;
  projectConfirmation(id: string, p: ConfirmationProjection): { replayed: boolean; item: JobItem | null };
  addEvent(id: string, input: JobEventInput): JobEvent;
}
