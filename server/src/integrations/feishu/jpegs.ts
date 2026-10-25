/**
 * 原图 JPEG 请求记录（F28）：意图 = (jobId, photoId, targetId) 稳定派生，同一目标同一张只发一次；
 * unknown 以同一 intentId（飞书 uuid 去重）重试，不换意图、不广播到其它目标。
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonlLog } from './jsonl.ts';

export interface JpegRecord { readonly intentId: string; readonly state: 'sent' | 'failed' | 'unknown'; readonly messageId?: string; readonly code?: string; readonly at: number }

export const jpegIntentId = (jobId: string, photoId: string, targetId: string) =>
  `jpeg_${createHash('sha256').update(`${jobId}\u0000${photoId}\u0000${targetId}`).digest('hex').slice(0, 40)}`;

export class JpegLog {
  readonly #log: JsonlLog<JpegRecord> | null;
  readonly #map = new Map<string, JpegRecord>();
  constructor(dataDir: string | null) {
    this.#log = dataDir ? new JsonlLog<JpegRecord>(path.join(dataDir, 'feishu', 'jpegs.jsonl')) : null;
    for (const r of this.#log?.load() ?? []) this.#map.set(r.intentId, r);
  }
  get(intentId: string): JpegRecord | undefined { return this.#map.get(intentId); }
  record(r: Omit<JpegRecord, 'at'>, now = Date.now()): void {
    const row = { ...r, at: now };
    this.#log?.append(row);
    this.#map.set(r.intentId, row);
  }
}
