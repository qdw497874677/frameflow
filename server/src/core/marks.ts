/**
 * 标注状态（星级 / 待删）与变更日志。
 *
 * 两个落点，各司其职：
 *  - **状态**落照片旁的 XMP（见 xmp.ts）—— 别的软件看得见，应用没了成果还在；
 *  - **每次成功写入（包括同值确认）**落 `dataDir/marks.jsonl`（追加型、不回改）—— 谁在什么时候把什么从什么改成了什么。
 *    它是把批注任务推给外部渠道（飞书、其他客户端）、再把别人的批注并回来时的对账凭据。
 *
 * 降级：XMP 写不进去时（只读共享、相机卡、权限不够），状态退到 marks.jsonl，
 * 也就是「服务端日志成为这一张的真相」，后续显式写入可再尝试回写（恢复不自动写侧车）—— 不因为盘只读就让打星失败。
 */

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MarksLog, hash, validInput, validateRequest, type MarkEnvelope, type MarkEntry, type MarkTransactionRequest, type MarkTransactionResult, type MarksLogOptions } from './mark-transaction.ts';
import { join } from 'node:path';
import { writeXmpMarks, type XmpMarks } from './xmp.ts';

export interface MarkInput {
  id: string;
  stars?: number;
  del?: boolean;
  at?: string;
  by?: string;
  channel?: string;
  /** 这次变更由哪个任务引起（批注任务回流 / 撤销）；散手标注为 null */
  jobId?: string | null;
}

export interface MarkChange {
  photoId: string;
  displayName?: string;
  field: 'stars' | 'del';
  from: number | boolean | null;
  to: number | boolean | null;
  by: string;
  channel: string;
  at: string;
  jobId?: string | null;
}

export interface MarkState {
  stars: number;
  del: boolean;
  /** 最后一次变更的来源与时刻（`by:` 选择集词就靠它） */
  by: string;
  channel: string;
  at: string;
}

export interface MarkResultDto {
  id: string;
  ok: boolean;
  stars?: number;
  del?: boolean;
  error?: string | null;
}

/** 一张照片在磁盘上的落点（由 Library 提供：它才知道 absStem） */
export interface MarkTarget {
  displayName?: string;
  sidecarPath?: string | null;
}

const inputId = (item: unknown): string => item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' ? item.id : '';
const clampStars = (n: number): number => Math.max(0, Math.min(5, Math.trunc(n) || 0));

export class MarksStore {
  private readonly log: MarksLog;
  private readonly state = new Map<string, MarkState>();
  private readonly revisions = new Map<string, number>();
  private readonly operations = new Map<string, { hash: string; result: MarkTransactionResult }>();
  private readonly changes: MarkChange[] = [];

  constructor(dataDir: string, options: MarksLogOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.log = new MarksLog(join(dataDir, 'marks.jsonl'), options);
    // MarksLog validates the full replay chain before any tail repair or recovery flush.
    for (const row of this.log.rows) {
      if ('version' in row) {
        for (const entry of row.entries) {
          this.state.set(entry.id, entry.state);
          this.revisions.set(entry.id, entry.newRevision);
          for (const ch of entry.changes) this.changes.unshift(ch);
        }
        this.operations.set(row.opId, { hash: row.requestHash, result: row.result });
      } else {
        this.changes.unshift(row);
        this.applyToState(row);
        this.revisions.set(row.photoId, this.revisionOf(row.photoId) + 1);
      }
    }
  }

  get repair() { return this.log.repair; }
  revisionOf(photoId: string): number { return this.revisions.get(photoId) ?? 0; }

  private applyToState(ch: MarkChange): void {
    const prev = this.state.get(ch.photoId) ?? { stars: 0, del: false, by: ch.by, channel: ch.channel, at: ch.at };
    const next: MarkState = { ...prev, by: ch.by, channel: ch.channel, at: ch.at };
    if (ch.field === 'stars') next.stars = typeof ch.to === 'number' ? ch.to : 0;
    if (ch.field === 'del') next.del = ch.to === true;
    this.state.set(ch.photoId, next);
  }

  /**
   * 扫描时用照片旁的 XMP 作基线。日志里有更晚的记录时不覆盖 ——
   * 盘上写不进去的那些（只读共享）正是靠这个保住状态的。
   */
  seedFromXmp(photoId: string, xmp: XmpMarks | null): void {
    if (!xmp || this.state.has(photoId)) return;
    if (xmp.stars === undefined && xmp.del === undefined) return;
    this.state.set(photoId, {
      stars: clampStars(xmp.stars ?? 0),
      del: xmp.del === true,
      by: 'xmp',
      channel: 'xmp',
      at: '',
    });
  }

  get(photoId: string): MarkState | undefined {
    const state = this.state.get(photoId);
    return state && { ...state };
  }

  starsOf(photoId: string): number {
    return this.state.get(photoId)?.stars ?? 0;
  }

  delOf(photoId: string): boolean {
    return this.state.get(photoId)?.del ?? false;
  }

  /** `by:` 选择集词用：最后一次标注变更是谁发起的（从未标注 → null） */
  lastBy(photoId: string): string | null {
    const s = this.state.get(photoId);
    if (!s || s.channel === 'xmp') return null;
    return s.by || null;
  }

  list(opts: { photoId?: string; jobId?: string; limit?: number } = {}): MarkChange[] {
    // limit: 0 = 不限（只给「按任务全量回滚」这种内部用途：changes 本来就在内存里）
    const limit = opts.limit === 0 ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(1000, opts.limit ?? 100));
    const out: MarkChange[] = [];
    for (const ch of this.changes) {
      if (opts.photoId && ch.photoId !== opts.photoId) continue;
      if (opts.jobId && ch.jobId !== opts.jobId) continue;
      out.push({ ...ch });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 批量写入。不变式：`stars > 0` 与 `del = true` 互斥，同时给出时以 `del` 为准（清星）。
   * 先暂存整批状态与变更，日志追加成功后才发布到内存，再尽力回写 XMP。
   * 日志写失败不发布任何变更；XMP 写失败时，日志里必须有。
   */
  async apply(items: MarkInput[], lookup: (photoId: string) => MarkTarget | null): Promise<MarkResultDto[]> {
    // Legacy API isolates invalid items, and historically permits omitted/undefined fields.
    const normalized = (items as unknown[]).map(item => validInput(item) ? item : { id: inputId(item), del: null });
    try {
      const result = await this.commit({ opId: randomUUID(), items: JSON.parse(JSON.stringify(normalized)) }, lookup, true);
      return result.results;
    } catch (err) {
      return items.map(item => ({ id: item?.id ?? '', ok: false, error: !validInput(item) ? 'INVALID_MARK_INPUT' :
        !lookup(item.id) ? '不认识这张照片（可能刚被移走或重命名）' : `变更日志写不进去：${String(err)}` }));
    }
  }

  /** Internal stable-op API. A committed replay never looks up a target or rewrites XMP.
   * Results describe the durable commit; XMP warnings belong only to this invocation.
   */
  async transact(request: MarkTransactionRequest, lookup: (photoId: string) => MarkTarget | null): Promise<MarkTransactionResult> {
    return this.commit(request, lookup, false);
  }

  private async commit(request: MarkTransactionRequest, lookup: (photoId: string) => MarkTarget | null, reportXmp: boolean): Promise<MarkTransactionResult> {
    validateRequest(request);
    this.log.assertWritable();
    const requestHash = hash(request);
    const previous = this.operations.get(request.opId);
    if (previous) {
      if (previous.hash !== requestHash) throw new Error('OP_ID_REUSED');
      return structuredClone(previous.result);
    }
    for (const [id, expected] of Object.entries(request.expectedRevisions ?? {})) {
      if (this.revisionOf(id) !== expected) throw new Error(`REVISION_CONFLICT: ${id}`);
    }
    const now = new Date().toISOString();
    const results: MarkResultDto[] = [];
    const stagedState = new Map<string, MarkState>();
    const stagedRevisions = new Map<string, number>();
    const entries: MarkEntry[] = [];
    const xmpJobs: { sidecarPath: string; stars: number; del: boolean }[] = [];

    for (const item of request.items) {
      if (!validInput(item)) {
        results.push({ id: inputId(item), ok: false, error: 'INVALID_MARK_INPUT' });
        continue;
      }
      const target = lookup(item.id);
      if (!target) {
        results.push({ id: item.id, ok: false, error: '不认识这张照片（可能刚被移走或重命名）' });
        continue;
      }
      const prev = stagedState.get(item.id) ?? this.state.get(item.id);
      const by = item.by ?? 'me';
      const channel = item.channel ?? 'inapp';
      const at = item.at ?? now;
      const jobId = item.jobId ?? null;
      let stars = clampStars(item.stars ?? prev?.stars ?? 0);
      let del = item.del ?? prev?.del ?? false;
      if (del) stars = 0;
      else if (stars > 0) del = false;
      const changed: MarkChange[] = [];
      const common = { photoId: item.id, ...(target.displayName === undefined ? {} : { displayName: target.displayName }), by, channel, at, jobId };
      if (stars !== (prev?.stars ?? 0)) changed.push({ ...common, field: 'stars', from: prev?.stars ?? 0, to: stars });
      if (del !== (prev?.del ?? false)) changed.push({ ...common, field: 'del', from: prev?.del ?? false, to: del });
      const state = { stars, del, by, channel, at };
      const expectedRevision = stagedRevisions.get(item.id) ?? this.revisionOf(item.id);
      const newRevision = expectedRevision + 1;
      if (!Number.isSafeInteger(newRevision)) throw new Error('MARK_REVISION_EXHAUSTED');
      entries.push({ id: item.id, expectedRevision, newRevision, state, changes: changed });
      stagedState.set(item.id, state);
      stagedRevisions.set(item.id, newRevision);
      if (target.sidecarPath) xmpJobs.push({ sidecarPath: target.sidecarPath, stars, del });
      results.push({ id: item.id, ok: true, stars, del, error: null });
    }
    const result: MarkTransactionResult = { opId: request.opId, results, revisions: Object.fromEntries(stagedRevisions) };
    const body = { version: 1 as const, kind: 'mark-transaction' as const, opId: request.opId, requestHash, entries,
      ...(request.confirmation === undefined ? {} : { confirmation: structuredClone(request.confirmation) }), result };
    const envelope: MarkEnvelope = { ...body, checksum: hash(body) };
    this.log.append(envelope);
    for (const [id, state] of stagedState) this.state.set(id, state);
    for (const [id, revision] of stagedRevisions) this.revisions.set(id, revision);
    for (const entry of entries) for (const ch of entry.changes) this.changes.unshift(ch);
    this.operations.set(request.opId, { hash: requestHash, result: structuredClone(result) });

    // No await before the durable index/publication. Concurrent duplicate calls replay it.
    const failed = new Map<string, string>();
    for (const job of xmpJobs) {
      try { await writeXmpMarks(job.sidecarPath, { stars: job.stars, del: job.del }); }
      catch (err) {
        failed.set(job.sidecarPath, String(err));
        if (!reportXmp) console.warn('MARKS_XMP_WRITE_FAILED', request.opId, String(err));
      }
    }
    if (reportXmp && failed.size) {
      const sample = failed.values().next().value ?? '';
      for (const r of results) {
        const target = lookup(r.id);
        if (r.ok && target?.sidecarPath && failed.has(target.sidecarPath)) {
          r.error = `照片旁写不进 XMP（${sample.slice(0, 120)}）：状态已记在服务端日志里`;
        }
      }
    }
    return result;
  }
}
