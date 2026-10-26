/**
 * 照片库事件流：入库、更新等「库里有新东西了」的通知。
 *
 * 进程内环形缓冲 + 订阅。序号单调递增，SSE 断线重连时带 `Last-Event-ID` 就能补上漏掉的；
 * 缓冲只留最近 {@link LibraryEventLog.capacity} 条 —— 补不上时客户端整页刷新即可（列表本身才是真值）。
 */

export type LibraryEventType = 'photos.added' | 'photos.updated';

export interface LibraryEvent {
  readonly seq: number;
  readonly at: string;
  readonly type: LibraryEventType;
  readonly rootId: string;
  readonly relDir: string;
  readonly photoIds: readonly string[];
  /** 谁带来的（ftp / watch …）；null = 不是入库产生的 */
  readonly source: string | null;
}

export type LibraryEventInput = Omit<LibraryEvent, 'seq' | 'at'>;

export interface LibraryEventSink {
  publish(input: LibraryEventInput): LibraryEvent;
}

export class LibraryEventLog implements LibraryEventSink {
  readonly capacity: number;
  private buf: LibraryEvent[] = [];
  private seq = 0;
  private readonly subs = new Set<(e: LibraryEvent) => void>();
  private readonly clock: () => Date;

  constructor(opts: { capacity?: number; clock?: () => Date } = {}) {
    this.capacity = opts.capacity ?? 200;
    this.clock = opts.clock ?? (() => new Date());
  }

  publish(input: LibraryEventInput): LibraryEvent {
    const event: LibraryEvent = { ...input, photoIds: [...input.photoIds], seq: ++this.seq, at: this.clock().toISOString() };
    this.buf.push(event);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    for (const fn of this.subs) {
      try { fn(event); } catch { /* 一个订阅者坏了不影响别人 */ }
    }
    return event;
  }

  /** seq 之后的事件；`gap` = 缓冲已经丢了一部分（客户端该整页刷新） */
  since(seq: number): { events: LibraryEvent[]; gap: boolean } {
    const events = this.buf.filter((e) => e.seq > seq);
    const oldest = this.buf[0]?.seq ?? this.seq + 1;
    return { events, gap: seq < this.seq && seq + 1 < oldest };
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(fn: (e: LibraryEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
