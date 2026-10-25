/**
 * 外传确认（F14）。
 *
 * 协议：校验预览 → **先**原子追加「已接受」记录（含预分配 jobId 与冻结快照，fsync）→ 再建任务。
 * - 已接受记录优先于预览期限：同 requestId 重试即使预览过期也走恢复路径，不会产生第二个任务。
 * - 崩溃在「记录后、建任务前」：重放（或启动 recover()）按记录补建，补建前重新校验目标授权；
 *   授权已撤销则把记录标为 aborted，不建任务、不外传。
 * - 同一 requestId 的并发确认在同步段内串行（无 await），只会接受一次。
 * - 一个预览只能被一个 requestId 确认；换 requestId 再确认同一预览 → PREVIEW_ALREADY_CONFIRMED。
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import type { DispatchParams, PreviewTarget } from './types.ts';
import { targetsStillAllowed, type PreviewService, type PreviewState } from './previews.ts';

export interface ConfirmInput {
  readonly previewId: string;
  readonly revision: string;
  readonly requestId: string;
  readonly notifyOnComplete: boolean;
  /** 有外部目标时必须为 true：用户已确认将外传到这些目标 */
  readonly acknowledged: boolean;
}

export interface AcceptedSnapshot {
  readonly projectId: string;
  readonly photoIds: readonly string[];
  readonly params: DispatchParams;
  readonly targets: readonly PreviewTarget[];
}

/** F29a：追加目标确认——绑定已有 jobId，只扩展目标投递记录 */
export interface AppendInput extends ConfirmInput { readonly jobId: string }
export interface AppendRecord {
  readonly t: 'appended';
  readonly requestId: string;
  readonly jobId: string;
  readonly previewId: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly targets: readonly PreviewTarget[];
  readonly notifyOnComplete: boolean;
  readonly at: string;
}

export interface ConfirmationRecord {
  readonly t: 'accepted' | 'aborted';
  readonly requestId: string;
  readonly jobId: string;
  readonly previewId: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly snapshot: AcceptedSnapshot;
  readonly at: string;
  readonly reason?: string;
}

export type ConfirmErrorCode =
  | 'INVALID' | 'CONSENT_REQUIRED' | 'REQUEST_ID_CONFLICT' | 'PREVIEW_ALREADY_CONFIRMED' | 'AUTHORIZATION_REVOKED'
  | 'PREVIEW_NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PREVIEW_REVISION_MISMATCH' | 'PREVIEW_STALE'
  | 'JOB_NOT_FOUND' | 'JOB_CLOSED' | 'PREVIEW_JOB_MISMATCH' | 'TARGET_ALREADY_IN_JOB';

export class ConfirmError extends Error {
  readonly code: ConfirmErrorCode;
  readonly detail?: string;
  constructor(code: ConfirmErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export interface ConfirmDeps<J> {
  readonly previews: PreviewService;
  readonly state: () => PreviewState;
  readonly currentPhotoIds: (projectId: string, photoIds: readonly string[]) => readonly string[];
  /** 幂等建任务（JobsService.createConfirmed）；同 jobId+requestId 重放必须返回同一任务 */
  readonly createJob: (rec: ConfirmationRecord) => J;
  /** 已建任务直接返回（重放不因后来的撤销而“丢”任务；外传由 runner 发送前复核） */
  readonly findJob: (jobId: string) => J | undefined;
  /** F29a：任务仍可追加目标（未取消/失败） */
  readonly jobOpen?: (jobId: string) => boolean;
}

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function inputFingerprint(i: ConfirmInput): string {
  return createHash('sha256').update(JSON.stringify([i.previewId, i.revision, i.notifyOnComplete, i.acknowledged])).digest('hex');
}

export class ConfirmationStore {
  readonly file: string;
  readonly #byRequest = new Map<string, ConfirmationRecord>();
  readonly #byPreview = new Map<string, string>();
  readonly #appends = new Map<string, AppendRecord>();

  private constructor(file: string) { this.file = file; }

  static open(dataDir: string): ConfirmationStore {
    fs.mkdirSync(dataDir, { recursive: true });
    const s = new ConfirmationStore(path.join(dataDir, 'delivery-confirmations.jsonl'));
    let text = '';
    try { text = fs.readFileSync(s.file, 'utf8'); } catch { /* 首次 */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ConfirmationRecord | AppendRecord;
        if (r.t === 'appended' && typeof r.requestId === 'string') s.#indexAppend(r);
        else if ((r.t === 'accepted' || r.t === 'aborted') && typeof r.requestId === 'string') s.#index(r);
      } catch { /* 半行：写到一半被杀，未 fsync 的接受视为没发生 */ }
    }
    return s;
  }

  #index(r: ConfirmationRecord): void {
    this.#byRequest.set(r.requestId, r);
    this.#byPreview.set(r.previewId, r.requestId);
  }

  #indexAppend(r: AppendRecord): void {
    this.#appends.set(r.requestId, r);
    this.#byPreview.set(r.previewId, r.requestId);
  }

  get(requestId: string): ConfirmationRecord | undefined { return this.#byRequest.get(requestId); }
  getAppend(requestId: string): AppendRecord | undefined { return this.#appends.get(requestId); }
  appendsOf(jobId: string): AppendRecord[] { return [...this.#appends.values()].filter((r) => r.jobId === jobId); }
  /** 任务的全部目标（原确认 + 追加），按加入顺序去重 */
  targetsOf(jobId: string): PreviewTarget[] {
    const base = this.byJob(jobId);
    if (!base) return [];
    const out = new Map<string, PreviewTarget>();
    for (const t of [...base.snapshot.targets, ...this.appendsOf(jobId).flatMap((a) => a.targets)]) out.set(`${t.connectorId}\u0000${t.targetId}`, t);
    return [...out.values()];
  }
  requestOfPreview(previewId: string): string | undefined { return this.#byPreview.get(previewId); }
  byJob(jobId: string): ConfirmationRecord | undefined { return this.all().find((r) => r.jobId === jobId); }
  all(): ConfirmationRecord[] { return [...this.#byRequest.values()]; }

  append(r: ConfirmationRecord | AppendRecord): void {
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(r)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (r.t === 'appended') this.#indexAppend(r); else this.#index(r);
  }
}

export class ConfirmationService<J> {
  readonly #store: ConfirmationStore;
  readonly #deps: ConfirmDeps<J>;
  readonly #now: () => number;

  get store(): ConfirmationStore { return this.#store; }

  constructor(store: ConfirmationStore, deps: ConfirmDeps<J>, now: () => number = Date.now) {
    this.#store = store;
    this.#deps = deps;
    this.#now = now;
  }

  confirm(input: ConfirmInput): { job: J; confirmation: ConfirmationRecord; replayed: boolean } {
    if (!ID_RE.test(input.requestId ?? '')) throw new ConfirmError('INVALID', 'requestId 需为 8–128 位字母数字/_/-');
    if (typeof input.previewId !== 'string' || typeof input.revision !== 'string') throw new ConfirmError('INVALID', '缺 previewId/revision');
    const fp = inputFingerprint(input);
    const prior = this.#store.get(input.requestId);
    if (prior) {
      if (prior.fingerprint !== fp) throw new ConfirmError('REQUEST_ID_CONFLICT', '同一 requestId 的确认内容不一致');
      return { job: this.#ensureJob(prior), confirmation: this.#store.get(input.requestId) ?? prior, replayed: true };
    }
    if (this.#store.requestOfPreview(input.previewId)) throw new ConfirmError('PREVIEW_ALREADY_CONFIRMED', '这个预览已经确认过了');
    const state = this.#deps.state();
    const p0 = this.#deps.previews.get(input.previewId);
    const current = p0 ? this.#deps.currentPhotoIds(p0.projectId, p0.photoIds) : [];
    const chk = this.#deps.previews.check(input.previewId, input.revision, state, current);
    if (!chk.ok) throw new ConfirmError(chk.code, '预览已失效，请重新预览', chk.detail);
    const p = chk.preview;
    if (p.targets.length && input.acknowledged !== true) throw new ConfirmError('CONSENT_REQUIRED', '有外部目标时需确认外传');
    const rec: ConfirmationRecord = {
      t: 'accepted', requestId: input.requestId, jobId: `job_${randomUUID().replace(/-/g, '')}`, previewId: p.previewId,
      revision: p.revision, fingerprint: fp, at: new Date(this.#now()).toISOString(),
      snapshot: { projectId: p.projectId, photoIds: [...p.photoIds], params: { ...p.params, notifyOnComplete: input.notifyOnComplete }, targets: p.targets.map((t) => ({ ...t })) },
    };
    this.#store.append(rec);
    this.#deps.previews.cancel(p.previewId);
    return { job: this.#deps.createJob(rec), confirmation: rec, replayed: false };
  }

  /**
   * F29a：追加目标。预览必须绑定同一 jobId；同 requestId 重放返回原记录（响应丢失后重试仍关联原任务）；
   * 不新建任务、不改 items/确认进度；新目标与已有目标不得重叠（旧目标不会再发）。
   */
  confirmAppend(input: AppendInput): { record: AppendRecord; replayed: boolean } {
    if (!ID_RE.test(input.requestId ?? '')) throw new ConfirmError('INVALID', 'requestId 需为 8–128 位字母数字/_/-');
    if (typeof input.previewId !== 'string' || typeof input.revision !== 'string' || typeof input.jobId !== 'string') throw new ConfirmError('INVALID', '缺 jobId/previewId/revision');
    const fp = createHash('sha256').update(JSON.stringify(['append', input.jobId, input.previewId, input.revision, input.notifyOnComplete, input.acknowledged])).digest('hex');
    const prior = this.#store.getAppend(input.requestId);
    if (prior) {
      if (prior.fingerprint !== fp) throw new ConfirmError('REQUEST_ID_CONFLICT', '同一 requestId 的确认内容不一致');
      return { record: prior, replayed: true };
    }
    if (this.#store.get(input.requestId)) throw new ConfirmError('REQUEST_ID_CONFLICT', 'requestId 已用于其它确认');
    if (this.#store.requestOfPreview(input.previewId)) throw new ConfirmError('PREVIEW_ALREADY_CONFIRMED', '这个预览已经确认过了');
    const base = this.#store.byJob(input.jobId);
    if (!base || base.t !== 'accepted' || this.#deps.findJob(input.jobId) === undefined) throw new ConfirmError('JOB_NOT_FOUND', '任务不存在或不是外传任务');
    if (this.#deps.jobOpen && !this.#deps.jobOpen(input.jobId)) throw new ConfirmError('JOB_CLOSED', '任务已取消或失败，不能追加目标');
    const p0 = this.#deps.previews.get(input.previewId);
    if (p0 && p0.jobId !== input.jobId) throw new ConfirmError('PREVIEW_JOB_MISMATCH', '预览不属于该任务');
    const current = p0 ? this.#deps.currentPhotoIds(p0.projectId, p0.photoIds) : [];
    const chk = this.#deps.previews.check(input.previewId, input.revision, this.#deps.state(), current);
    if (!chk.ok) throw new ConfirmError(chk.code, '预览已失效，请重新预览', chk.detail);
    const p = chk.preview;
    if (p.jobId !== input.jobId) throw new ConfirmError('PREVIEW_JOB_MISMATCH', '预览不属于该任务');
    if (!p.targets.length) throw new ConfirmError('INVALID', '没有新增目标');
    const have = new Set(this.#store.targetsOf(input.jobId).map((t) => `${t.connectorId}\u0000${t.targetId}`));
    if (p.targets.some((t) => have.has(`${t.connectorId}\u0000${t.targetId}`))) throw new ConfirmError('TARGET_ALREADY_IN_JOB', '目标已在任务中；失败重试请用重试入口');
    if (input.acknowledged !== true) throw new ConfirmError('CONSENT_REQUIRED', '有外部目标时需确认外传');
    const record: AppendRecord = {
      t: 'appended', requestId: input.requestId, jobId: input.jobId, previewId: p.previewId, revision: p.revision, fingerprint: fp,
      targets: p.targets.map((t) => ({ ...t })), notifyOnComplete: input.notifyOnComplete, at: new Date(this.#now()).toISOString(),
    };
    this.#store.append(record);
    this.#deps.previews.cancel(p.previewId);
    return { record, replayed: false };
  }

  /** 启动恢复：对每条 accepted 记录幂等补建任务；授权已撤销的标 aborted。返回恢复/中止数。 */
  recover(): { recovered: number; aborted: number } {
    let recovered = 0;
    let aborted = 0;
    for (const r of this.#store.all()) {
      if (r.t !== 'accepted') continue;
      try { this.#ensureJob(r); recovered++; } catch (e) { if (e instanceof ConfirmError && e.code === 'AUTHORIZATION_REVOKED') aborted++; else throw e; }
    }
    return { recovered, aborted };
  }

  #ensureJob(r: ConfirmationRecord): J {
    const existing = r.t === 'accepted' ? this.#deps.findJob(r.jobId) : undefined;
    if (existing !== undefined) return this.#deps.createJob(r);
    if (r.t === 'aborted') throw new ConfirmError('AUTHORIZATION_REVOKED', `该确认已中止：${r.reason ?? ''}`);
    const revoked = targetsStillAllowed(this.#deps.state(), r.snapshot.projectId, r.snapshot.targets);
    if (revoked) {
      const abortedRec: ConfirmationRecord = { ...r, t: 'aborted', at: new Date(this.#now()).toISOString(), reason: `target ${revoked.connectorId}/${revoked.targetId} revoked` };
      this.#store.append(abortedRec);
      throw new ConfirmError('AUTHORIZATION_REVOKED', '目标授权已撤销，未创建任务');
    }
    return this.#deps.createJob(r);
  }
}
