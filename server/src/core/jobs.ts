/**
 * 任务层：任务快照 + 状态机 + 追加型事件日志（见 docs/core-model.md §7 与票 014）。
 *
 * 两个落点（都在 dataDir，**只追加、不回改**，符合不变量 3/6）：
 *  - `jobs.jsonl`：任务快照，一行 = `{t:'job', ...Job}`；同一 id **后写的覆盖先写的**（重放取最后一条）。
 *  - `job-events.jsonl`：事件流水，一行 = `{t:'event', jobId, ...JobEvent}`；`seq` 全局单调递增，
 *    重放时接着最大值发号 —— 增量轮询（`GET /jobs/{id}/events?since=`）的游标就是它。
 *
 * 重启：`queued` / `running` 的执行者已经不在这个进程里了，收敛成 `interrupted`（不假装还在跑），
 * 并把这次收敛写回日志 —— 否则每次重启都要再收敛一遍、事件流里也会重复。执行队列本身**不持久化**，
 * 「接着跑」由人重新发起（任务重开/新建），见 jobs/service.ts。
 *
 * 状态机：`planned → queued → running → done | failed | cancelled`，`interrupted` 是重启收敛态，
 * 非法迁移抛 `JobError('conflict')`（HTTP 层映射 409）。
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Selection } from './selection.ts';

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
}

/** `jobs.jsonl` 的一行 */
interface JobLine {
  t?: string;
  id?: string;
  state?: JobState;
}

/** `job-events.jsonl` 的一行 */
interface EventLine {
  t?: string;
  jobId?: string;
  seq?: number;
}

export class JobsStore {
  private readonly jobsFile: string;
  private readonly eventsFile: string;
  private readonly byId = new Map<string, Job>();
  private readonly eventsById = new Map<string, JobEvent[]>();
  private readonly byRequest = new Map<string, string>();
  private nextSeq = 1;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.jobsFile = join(dataDir, 'jobs.jsonl');
    this.eventsFile = join(dataDir, 'job-events.jsonl');
    this.loadLog();
  }

  // ── 重放 ────────────────────────────────────────────────────────────────

  private loadLog(): void {
    // 先修尾巴：被杀在写一半的文件会留一行残记录，不截掉就会让下次 append 粘成坏行
    repairPartialTail(this.jobsFile);
    repairPartialTail(this.eventsFile);
    for (const line of readLines(this.jobsFile)) {
      try {
        const rec = JSON.parse(line) as JobLine & Job;
        if (rec?.t !== 'job' || typeof rec.id !== 'string' || !rec.state || !Array.isArray(rec.items)) continue;
        this.byId.set(rec.id, rec);
        if (typeof rec.requestId === 'string') this.byRequest.set(rec.requestId, rec.id);
      } catch {
        // 半行（写到一半被杀）跳过：任务快照本来就是「后写的赢」，丢最后一行只丢一次更新
      }
    }
    for (const line of readLines(this.eventsFile)) {
      try {
        const ev = JSON.parse(line) as EventLine & JobEvent;
        if (ev?.t !== 'event' || typeof ev.jobId !== 'string' || typeof ev.seq !== 'number') continue;
        const list = this.eventsById.get(ev.jobId) ?? [];
        list.push(ev);
        this.eventsById.set(ev.jobId, list);
        if (ev.seq >= this.nextSeq) this.nextSeq = ev.seq + 1;
      } catch {
        // 同上：跳过坏行
      }
    }
    // 重启收敛：没有执行者的 queued/running 不假装还在跑（票 014）
    for (const job of this.byId.values()) {
      if (job.state !== 'queued' && job.state !== 'running') continue;
      job.state = 'interrupted';
      job.finishedAt = new Date().toISOString();
      this.save(job);
      this.appendEvent(job.id, { type: 'note', note: '服务重启：没有执行者了，任务收敛为 interrupted（可撤销或重开）' });
    }
  }

  // ── 读 ──────────────────────────────────────────────────────────────────

  get(id: string): Job | undefined {
    const job = this.byId.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /** 最新的在前 */
  list(opts: { state?: string; limit?: number } = {}): Job[] {
    const states = (opts.state ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = clampCount(opts.limit, 50, 500);
    return [...this.byId.values()]
      .filter((j) => !states.length || states.includes(j.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }

  events(id: string, opts: { since?: number; limit?: number } = {}): { items: JobEvent[]; nextSince: number } {
    // query 里来的都是字符串：`?limit=abc` 会变成 NaN，别让它静默变成「一条都不给」
    const since = opts.since !== undefined && Number.isFinite(opts.since) ? Math.max(0, Math.trunc(opts.since)) : 0;
    const limit = clampCount(opts.limit, 200, 1000);
    const all = this.eventsById.get(id) ?? [];
    const items: JobEvent[] = [];
    for (const ev of all) {
      if (ev.seq <= since) continue;
      items.push(structuredClone(ev));
      if (items.length >= limit) break;
    }
    const last = items[items.length - 1];
    return { items, nextSince: last ? last.seq : since };
  }

  /** 这个任务是不是写过这一张（回流只认 items 快照里的照片） */
  hasItem(id: string, photoId: string): boolean {
    return this.byId.get(id)?.items.some((i) => i.id === photoId) ?? false;
  }

  /** 确认式创建的幂等查找 */
  byRequestId(requestId: string): Job | undefined {
    const id = this.byRequest.get(requestId);
    return id ? this.get(id) : undefined;
  }

  hasEvent(id: string, type: JobEventType): boolean {
    return (this.eventsById.get(id) ?? []).some((e) => e.type === type);
  }

  // ── 写 ──────────────────────────────────────────────────────────────────

  create(input: JobCreateRecord): Job {
    const items = input.items.map((i) => ({ ...i, status: i.status ?? ('planned' as const) }));
    const id = input.id ?? randomBytes(8).toString('base64url');
    if (this.byId.has(id)) throw new JobError('conflict', `任务 id 已存在：${id}`);
    if (input.requestId && this.byRequest.has(input.requestId)) throw new JobError('conflict', `requestId 已用于另一个任务`);
    const job: Job = {
      id,
      kind: input.kind,
      state: input.state ?? 'planned',
      selection: input.selection,
      params: input.params ?? {},
      channel: input.channel ?? null,
      dispatchedAt: null,
      progress: jobProgress(items),
      items,
      artifacts: [],
      error: null,
      reversible: input.reversible,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      ...(input.requestId ? { requestId: input.requestId, requestFingerprint: input.requestFingerprint ?? null } : {}),
    };
    this.byId.set(job.id, job);
    if (input.requestId) this.byRequest.set(input.requestId, job.id);
    this.save(job);
    this.appendEvent(job.id, {
      type: 'created',
      by: input.by ?? null,
      note: `创建任务：${job.kind}，${items.length} 个项目（选择集已展开成 items 快照）`,
    });
    return structuredClone(job);
  }

  /** 状态迁移；同状态视为幂等（no-op），非法迁移抛 409 级的 JobError。 */
  setState(id: string, next: JobState, opts: { error?: string | null; at?: string } = {}): Job {
    const job = this.mustGet(id);
    if (job.state === next) return structuredClone(job);
    if (!TRANSITIONS[job.state].includes(next)) {
      throw new JobError('conflict', `任务状态不能从 ${job.state} 变成 ${next}`);
    }
    const at = opts.at ?? new Date().toISOString();
    job.state = next;
    if (next === 'running') job.startedAt = job.startedAt ?? at;
    if (next === 'done' || next === 'failed' || next === 'cancelled') job.finishedAt = at;
    if (opts.error !== undefined) job.error = opts.error;
    this.save(job);
    return structuredClone(job);
  }

  /** 改任务级字段（error / channel / dispatchedAt / params…） */
  patch(id: string, patch: Partial<Job>): Job {
    const job = this.mustGet(id);
    const next = applyDefined(job, patch);
    next.progress = jobProgress(next.items);
    this.byId.set(id, next);
    this.save(next);
    return structuredClone(next);
  }

  updateItem(id: string, itemId: string, patch: Partial<JobItem>): JobItem | null {
    const job = this.mustGet(id);
    const idx = job.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return null;
    const next = applyDefined(job.items[idx]!, patch);
    job.items = job.items.map((i, n) => (n === idx ? next : i));
    job.progress = jobProgress(job.items);
    this.save(job);
    return structuredClone(next);
  }

  addArtifact(id: string, artifact: Artifact): Job {
    const job = this.mustGet(id);
    job.artifacts = [...job.artifacts, artifact];
    this.save(job);
    return structuredClone(job);
  }

  /** 追加一条事件；`seq` 由这里发号（全局单调，进程内唯一） */
  addEvent(id: string, input: JobEventInput): JobEvent {
    return this.appendEvent(id, input);
  }

  private appendEvent(id: string, input: JobEventInput): JobEvent {
    const ev: JobEvent = {
      seq: this.nextSeq++,
      at: input.at ?? new Date().toISOString(),
      type: input.type,
      photoId: input.photoId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      by: input.by ?? null,
      channel: input.channel ?? null,
      clientRef: input.clientRef ?? null,
      note: input.note ?? null,
    };
    const list = this.eventsById.get(id) ?? [];
    list.push(ev);
    this.eventsById.set(id, list);
    appendLines(this.eventsFile, [JSON.stringify({ t: 'event', jobId: id, ...ev })]);
    return ev;
  }

  private mustGet(id: string): Job {
    const job = this.byId.get(id);
    if (!job) throw new JobError('notfound', `没这个任务：${id}`);
    return job;
  }

  private save(job: Job): void {
    this.byId.set(job.id, job);
    appendLines(this.jobsFile, [JSON.stringify({ t: 'job', ...job })]);
  }
}

/** 只覆盖明确给出的字段：`undefined` = 不动，`null` = 清空 */
function clampCount(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function applyDefined<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) next[key] = value as T[keyof T];
  }
  return next;
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return []; // 日志读不动不致命：当没有任务（jobs.jsonl 不可重建，但也不该让进程起不来）
  }
}

/**
 * 崩溃可能把最后一行写残（进程死在 appendFileSync 中途）：重放时把残行截掉。
 * 不截的话，下次 append 会跟残行粘成一条坏记录 —— 重放时那一条（以及它代表的更新）就丢了。
 */
function repairPartialTail(file: string): void {
  try {
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf8');
    if (raw.length === 0 || raw.endsWith('\n')) return;
    const cut = raw.lastIndexOf('\n');
    writeFileSync(file, cut >= 0 ? raw.slice(0, cut + 1) : '', 'utf8');
  } catch {
    // 读写不动就算了：下一次 append 前还有一次补换行的机会
  }
}

function appendLines(file: string, lines: string[]): void {
  try {
    // 保险：文件不是以换行结尾时先补一个（否则新记录会粘在残行尾巴上）
    const prefix = endsWithNewline(file) ? '' : '\n';
    appendFileSync(file, `${prefix}${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 写不进去（只读数据目录）也要能跑：内存里的状态照样服务得动，只是重启后丢
  }
}

function endsWithNewline(file: string): boolean {
  try {
    if (!existsSync(file)) return true;
    const size = statSync(file).size;
    if (size === 0) return true;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf[0] === 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return true; // 查不了就别乱加换行（appendFileSync 自己会处理不存在的情况）
  }
}
