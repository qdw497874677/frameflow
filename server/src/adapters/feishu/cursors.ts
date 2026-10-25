/**
 * 目标游标（F22）：每个 (jobId, targetId) 独立记录当前看到哪张、卡片消息 id。
 * 群里与私聊各自推进，互不影响；重启后从日志恢复。
 */
import path from 'node:path';
import { JsonlLog } from './jsonl.ts';

export interface TargetCursor {
  readonly jobId: string;
  readonly targetId: string;
  readonly photoId: string | null;
  readonly messageId: string | null;
  readonly sessionId: string | null;
  readonly at: number;
}

const key = (jobId: string, targetId: string) => `${jobId}\u0000${targetId}`;

export class CursorStore {
  readonly #log: JsonlLog<TargetCursor>;
  readonly #map = new Map<string, TargetCursor>();
  constructor(dataDir: string) {
    this.#log = new JsonlLog<TargetCursor>(path.join(dataDir, 'feishu', 'cursors.jsonl'));
    for (const c of this.#log.load()) this.#map.set(key(c.jobId, c.targetId), c);
    this.#compact();
  }
  /** 每个 (job, target) 只保留最后一行 */
  #compact(): void { this.#log.compactIfNeeded(this.#map.size, () => [...this.#map.values()]); }
  get(jobId: string, targetId: string): TargetCursor | undefined { return this.#map.get(key(jobId, targetId)); }
  set(c: Omit<TargetCursor, 'at'>, now = Date.now()): TargetCursor {
    const row = { ...c, at: now };
    this.#log.append(row);
    this.#map.set(key(c.jobId, c.targetId), row);
    this.#compact();
    return row;
  }
  listJob(jobId: string): TargetCursor[] { return [...this.#map.values()].filter((c) => c.jobId === jobId); }
}
