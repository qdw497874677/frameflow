/** 外传确认记录的追加日志（delivery-confirmations.jsonl，fsync 后才算接受）。协议见 application/delivery/confirmation-service.ts。 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { PreviewTarget } from '../../../domain/delivery/types.ts';
import type { AppendRecord, ConfirmationRecord } from '../../../domain/delivery/confirmation.ts';
import type { ConfirmationLog } from '../../../application/delivery/ports.ts';

export class ConfirmationStore implements ConfirmationLog {
  readonly file: string;
  readonly #byRequest = new Map<string, ConfirmationRecord>();
  readonly #byPreview = new Map<string, string>();
  readonly #appends = new Map<string, AppendRecord>();

  /** F31：完整行损坏 → 不可信，确认/追加/恢复全部拒绝 */
  corrupt: string | null = null;
  private constructor(file: string) { this.file = file; }

  static open(dataDir: string): ConfirmationStore {
    fs.mkdirSync(dataDir, { recursive: true });
    const s = new ConfirmationStore(path.join(dataDir, 'delivery-confirmations.jsonl'));
    let text = '';
    try { text = fs.readFileSync(s.file, 'utf8'); } catch { /* 首次 */ }
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const tail = i === lines.length - 1;
      try {
        const r = JSON.parse(line) as ConfirmationRecord | AppendRecord;
        if (r.t === 'appended' && typeof r.requestId === 'string') s.#indexAppend(r);
        else if ((r.t === 'accepted' || r.t === 'aborted') && typeof r.requestId === 'string') s.#index(r);
        else if (!tail) s.corrupt ??= `LINE_${i + 1}_UNKNOWN_RECORD`;
      } catch { if (!tail) s.corrupt ??= `LINE_${i + 1}_INVALID_JSON`; /* 尾部半行：写到一半被杀，视为没发生 */ }
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
