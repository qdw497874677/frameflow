/**
 * 实时入库编排：来源报「到了」→ 稳定判定 → 配对窗口 → 目录增量入库 → 发库事件。
 *
 * 不碰 I/O：文件观察、入库、事件都经端口（ports.ts）。同一时间只跑一个入库（串行），
 * 免得两个目录的增量扫描同时改照片索引。
 */

import { isIngestible, PairingWindow, StabilityPolicy, type FileObservation, type IngestedFile, type IngestSourceKind } from '../../domain/ingest/arrival.ts';
import type { LibraryEventSink } from '../library/events.ts';
import type { FileProbe, IngestArrival, IngestCatalog, IngestClock, IngestSink, IngestSource } from './ports.ts';

export interface IngestOptions {
  /** 写入稳定判定的静默时长（毫秒） */
  readonly stableMs: number;
  /** 配对窗口（毫秒）：同目录最后一次到达后再等这么久才入库 */
  readonly pairWindowMs: number;
  /** 一个文件最多观察多久（还在变就放弃，等下次扫描兜底） */
  readonly maxWaitMs: number;
}

export interface IngestStats {
  received: number;
  ignored: number;
  ingested: number;
  failed: number;
  lastAt: string | null;
  lastError: string | null;
  watching: number;
}

interface Watch {
  readonly arrival: IngestArrival;
  readonly source: IngestSourceKind;
  readonly firstAt: number;
  prev: FileObservation | null;
  cancel: () => void;
}

const key = (a: IngestArrival) => `${a.rootId}\u0000${a.relDir}\u0000${a.name}`;

export interface IngestDeps {
  readonly sources: readonly IngestSource[];
  readonly catalog: IngestCatalog;
  readonly probe: FileProbe;
  readonly events: LibraryEventSink;
  readonly clock: IngestClock;
  readonly onError?: (text: string) => void;
}

export class IngestService {
  private readonly stability: StabilityPolicy;
  private readonly window: PairingWindow;
  private readonly watches = new Map<string, Watch>();
  private flushCancel: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = true;
  private readonly stats: IngestStats = { received: 0, ignored: 0, ingested: 0, failed: 0, lastAt: null, lastError: null, watching: 0 };

  private readonly deps: IngestDeps;
  private readonly opts: IngestOptions;

  constructor(deps: IngestDeps, opts: IngestOptions) {
    this.deps = deps;
    this.opts = opts;
    this.stability = new StabilityPolicy(opts.stableMs);
    this.window = new PairingWindow(opts.pairWindowMs);
  }

  private get clock(): IngestClock {
    return this.deps.clock;
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const src of this.deps.sources) {
      const sink: IngestSink = { arrived: (a) => this.arrived(a, src.kind) };
      await src.start(sink);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.watches.values()) w.cancel();
    this.watches.clear();
    this.flushCancel?.();
    this.flushCancel = null;
    await Promise.all(this.deps.sources.map((s) => s.stop().catch(() => undefined)));
    await this.chain;
  }

  /** 等手头所有观察与入库都结束（测试用） */
  async idle(): Promise<void> {
    while (this.watches.size || this.window.size) await new Promise((r) => setTimeout(r, 5));
    await this.chain;
  }

  status(): { stats: IngestStats; sources: Record<string, unknown>[] } {
    return { stats: { ...this.stats, watching: this.watches.size }, sources: this.deps.sources.map((s) => ({ kind: s.kind, ...s.status() })) };
  }

  /** 来源回调：可能被同一个文件反复触发（目录监听尤其如此） */
  arrived(arrival: IngestArrival, source: IngestSourceKind): void {
    if (this.stopped) return;
    if (!isIngestible(arrival.name)) {
      this.stats.ignored++;
      return;
    }
    this.stats.received++;
    const k = key(arrival);
    const existing = this.watches.get(k);
    if (existing) {
      // 还在观察：重新计时（大小变了下次检查自然会发现）；FTP 报完成则立即升级
      if (!arrival.complete) return;
      existing.cancel();
      this.watches.delete(k);
    }
    const watch: Watch = { arrival, source, firstAt: this.clock.now(), prev: null, cancel: () => undefined };
    this.watches.set(k, watch);
    void this.check(k, watch);
  }

  private async check(k: string, watch: Watch): Promise<void> {
    if (this.stopped || this.watches.get(k) !== watch) return;
    const { rootId, relDir, name, complete } = watch.arrival;
    let seen: { size: number; mtimeMs: number } | null;
    try {
      seen = await this.deps.probe.observe(rootId, relDir, name);
    } catch (err) {
      seen = null;
      this.fail(`看不了 ${relDir}/${name}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.watches.get(k) !== watch) return;
    const now = this.clock.now();
    const obs: FileObservation | null = seen ? { ...seen, at: now } : null;
    const verdict = complete && obs && obs.size > 0 ? { state: 'stable' as const } : this.stability.judge(watch.prev, obs);
    if (verdict.state === 'gone') {
      this.watches.delete(k);
      return;
    }
    if (verdict.state === 'pending') {
      if (now - watch.firstAt > this.opts.maxWaitMs) {
        this.watches.delete(k);
        this.fail(`${relDir}/${name} 超过 ${Math.round(this.opts.maxWaitMs / 1000)} 秒还在变：先不入库，下次扫描会带上`);
        return;
      }
      watch.prev = obs;
      watch.cancel = this.clock.after(verdict.recheckInMs, () => void this.check(k, watch));
      return;
    }
    this.watches.delete(k);
    const file: IngestedFile = { rootId, relDir, name, size: obs!.size, at: now, source: watch.source };
    this.window.add(file);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.flushCancel?.();
    const due = this.window.nextDueAt();
    if (due === null) return;
    this.flushCancel = this.clock.after(Math.max(0, due - this.clock.now()), () => {
      this.flushCancel = null;
      this.flush();
    });
  }

  private flush(): void {
    const due = this.window.takeDue(this.clock.now());
    this.scheduleFlush();
    for (const dir of due) {
      this.chain = this.chain.then(async () => {
        try {
          const res = await this.deps.catalog.ingestDir(dir.rootId, dir.relDir);
          const sources = [...new Set(dir.files.map((f) => f.source))].join(',');
          this.stats.ingested += dir.files.length;
          this.stats.lastAt = new Date(this.clock.now()).toISOString();
          if (res.added.length) this.deps.events.publish({ type: 'photos.added', rootId: dir.rootId, relDir: dir.relDir, photoIds: res.added, source: sources });
          if (res.updated.length) this.deps.events.publish({ type: 'photos.updated', rootId: dir.rootId, relDir: dir.relDir, photoIds: res.updated, source: sources });
        } catch (err) {
          this.fail(`入库失败 ${dir.rootId}/${dir.relDir}：${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
  }

  private fail(text: string): void {
    this.stats.failed++;
    this.stats.lastError = text;
    this.deps.onError?.(text);
  }
}
