/**
 * 标注状态（星级 / 待删）与变更日志。
 *
 * 两个落点，各司其职：
 *  - **状态**落照片旁的 XMP（见 xmp.ts）—— 别的软件看得见，应用没了成果还在；
 *  - **每次实际变化**落 `dataDir/marks.jsonl`（追加型、不回改）—— 谁在什么时候把什么从什么改成了什么。
 *    它是把批注任务推给外部渠道（飞书、其他客户端）、再把别人的批注并回来时的对账凭据。
 *
 * 降级：XMP 写不进去时（只读共享、相机卡、权限不够），状态退到 marks.jsonl，
 * 也就是「服务端日志成为这一张的真相」，能写的时候再回写 —— 不因为盘只读就让打星失败。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeXmpMarks, type XmpMarks } from './xmp.ts';

export interface MarkInput {
  id: string;
  stars?: number;
  del?: boolean;
  at?: string;
  by?: string;
  channel?: string;
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

const clampStars = (n: number): number => Math.max(0, Math.min(5, Math.trunc(n) || 0));

export class MarksStore {
  private readonly logFile: string;
  private readonly state = new Map<string, MarkState>();
  /** 最新的在前 */
  private readonly changes: MarkChange[] = [];

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.logFile = join(dataDir, 'marks.jsonl');
    this.loadLog();
  }

  private loadLog(): void {
    if (!existsSync(this.logFile)) return;
    let text: string;
    try {
      text = readFileSync(this.logFile, 'utf8');
    } catch {
      return; // 日志读不动不致命：这一轮就先靠 XMP
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ch = JSON.parse(line) as MarkChange;
        if (!ch?.photoId || !ch.field) continue;
        this.changes.unshift(ch);
        this.applyToState(ch);
      } catch {
        // 半行（写到一半被杀）跳过
      }
    }
  }

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
    return this.state.get(photoId);
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

  list(opts: { photoId?: string; limit?: number } = {}): MarkChange[] {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const out: MarkChange[] = [];
    for (const ch of this.changes) {
      if (opts.photoId && ch.photoId !== opts.photoId) continue;
      out.push(ch);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 批量写入。不变式：`stars > 0` 与 `del = true` 互斥，同时给出时以 `del` 为准（清星）。
   * 先落状态与日志（内存 + jsonl），再尽力回写 XMP —— 顺序不能反：
   * 盘上写失败时，日志里必须有。
   */
  apply(items: MarkInput[], lookup: (photoId: string) => MarkTarget | null): MarkResultDto[] {
    const now = new Date().toISOString();
    const results: MarkResultDto[] = [];
    const lines: string[] = [];
    const xmpJobs: { sidecarPath: string; stars: number; del: boolean }[] = [];

    for (const item of items) {
      const target = lookup(item.id);
      if (!target) {
        results.push({ id: item.id, ok: false, error: '不认识这张照片（可能刚被移走或重命名）' });
        continue;
      }
      const prev = this.state.get(item.id);
      const by = item.by ?? 'me';
      const channel = item.channel ?? 'inapp';
      const at = item.at ?? now;

      let stars = clampStars(item.stars ?? prev?.stars ?? 0);
      let del = item.del ?? prev?.del ?? false;
      if (del) stars = 0; // 互斥：待删优先
      else if (stars > 0) del = false;

      const prevStars = prev?.stars ?? 0;
      const prevDel = prev?.del ?? false;
      const changed: MarkChange[] = [];
      if (stars !== prevStars) {
        changed.push({ photoId: item.id, displayName: target.displayName, field: 'stars', from: prevStars, to: stars, by, channel, at });
      }
      if (del !== prevDel) {
        changed.push({ photoId: item.id, displayName: target.displayName, field: 'del', from: prevDel, to: del, by, channel, at });
      }

      this.state.set(item.id, { stars, del, by, channel, at });
      for (const ch of changed) {
        lines.push(JSON.stringify(ch));
        this.changes.unshift(ch);
      }
      if (target.sidecarPath) xmpJobs.push({ sidecarPath: target.sidecarPath, stars, del });

      results.push({ id: item.id, ok: true, stars, del, error: null });
    }

    if (lines.length) {
      try {
        appendFileSync(this.logFile, `${lines.join('\n')}\n`, 'utf8');
      } catch (err) {
        return results.map((r) => (r.ok ? { ...r, error: `变更日志写不进去：${String(err)}` } : r));
      }
    }

    // 回写 XMP：失败不改状态（日志已经是真相），只在结果里说一声
    const failed = new Map<string, string>();
    for (const job of xmpJobs) {
      try {
        writeXmpMarks(job.sidecarPath, { stars: job.stars, del: job.del });
      } catch (err) {
        failed.set(job.sidecarPath, String(err));
      }
    }
    if (failed.size) {
      const sample = failed.values().next().value ?? '';
      for (const r of results) {
        const target = lookup(r.id);
        if (r.ok && target?.sidecarPath && failed.has(target.sidecarPath)) {
          r.error = `照片旁写不进 XMP（${sample.slice(0, 120)}）：状态已记在服务端日志里`;
        }
      }
    }
    return results;
  }
}
