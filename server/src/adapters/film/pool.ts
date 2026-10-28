/**
 * 整帧渲染进程池：烘焙 / 目录走第 0 个进程（与以前一样），整帧渲染分给最闲的进程。
 *
 * - 并发上限 = 进程数（每个进程内部再多线程）；多出来的排队
 * - 超时按像素数放宽：baseMs + msPerMp × 百万像素（18 MP 实测约 5 s，缺省给到约 1 分钟）
 * - 内存闸门：按 filmRenderBytes 估计工作内存，进行中的总和不超过预算；单张超过最大像素数直接拒
 */
import type { FilmEngine, FilmEngineHealth, FilmRenderRequest } from '../../application/grading/ports.ts';
import { filmRenderBytes, type FilmParams, type FilmStock } from '../../domain/grading/film.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import { EngineError, type ProcessFilmEngine } from './process-engine.ts';

export interface RenderPoolOptions {
  /** 超时 = baseMs + msPerMp × 百万像素 */
  readonly baseMs?: number;
  readonly msPerMp?: number;
  /** 进行中渲染的估计工作内存上限（字节） */
  readonly memoryBytes?: number;
  /** 单张最大像素数（百万） */
  readonly maxMegapixels?: number;
  readonly now?: () => number;
}

interface Waiter { bytes: number; go: () => void }

export class FilmEnginePool implements FilmEngine {
  private readonly workers: readonly ProcessFilmEngine[];
  private readonly opts: Required<Omit<RenderPoolOptions, 'now'>>;
  private readonly now: () => number;
  private reserved = 0;
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private done = 0;
  private failed = 0;
  private lastMs: number | null = null;

  constructor(workers: readonly ProcessFilmEngine[], opts: RenderPoolOptions = {}) {
    if (!workers.length) throw new Error('进程池至少要一个引擎进程');
    this.workers = workers;
    this.opts = {
      baseMs: opts.baseMs ?? 20_000,
      msPerMp: opts.msPerMp ?? 2_000,
      memoryBytes: opts.memoryBytes ?? 3 * 1024 ** 3,
      maxMegapixels: opts.maxMegapixels ?? 100,
    };
    this.now = opts.now ?? Date.now;
  }

  private get primary(): ProcessFilmEngine { return this.workers[0]!; }

  stocks(): Promise<FilmStock[]> { return this.primary.stocks(); }
  bakeLut(req: { stock: string; paper?: string; size: number; params?: FilmParams }): Promise<Lut3D> { return this.primary.bakeLut(req); }
  version(): string | null { return this.primary.version(); }

  health(): FilmEngineHealth {
    return {
      ...this.primary.health(),
      renders: { workers: this.workers.length, active: this.active, queued: this.waiting.length, done: this.done, failed: this.failed, lastMs: this.lastMs },
    };
  }

  /** 这张图的超时（毫秒） */
  timeoutFor(width: number, height: number): number {
    return Math.round(this.opts.baseMs + this.opts.msPerMp * (width * height) / 1e6);
  }

  async render(req: FilmRenderRequest): Promise<Uint8Array> {
    const mp = (req.width * req.height) / 1e6;
    if (mp > this.opts.maxMegapixels) throw new EngineError('too_large', `照片 ${mp.toFixed(1)} MP 超过整帧渲染上限 ${this.opts.maxMegapixels} MP`);
    // 预算比单张还小时也放行一张（否则永远等不到），只是不和别的并行
    const bytes = Math.min(filmRenderBytes(req.width, req.height), this.opts.memoryBytes);
    await this.acquire(bytes);
    const t0 = this.now();
    try {
      const worker = this.workers.reduce((a, b) => (b.load() < a.load() ? b : a));
      const out = await worker.render(req, this.timeoutFor(req.width, req.height));
      this.done++;
      this.lastMs = this.now() - t0;
      return out;
    } catch (e) {
      this.failed++;
      throw e;
    } finally {
      this.release(bytes);
    }
  }

  private acquire(bytes: number): Promise<void> {
    if (this.active < this.workers.length && this.reserved + bytes <= this.opts.memoryBytes && !this.waiting.length) {
      this.active++;
      this.reserved += bytes;
      return Promise.resolve();
    }
    return new Promise((go) => this.waiting.push({ bytes, go }));
  }

  private release(bytes: number): void {
    this.active--;
    this.reserved -= bytes;
    // 按先来后到放行，排头放不下就等（不让小图插队饿死大图）
    while (this.waiting.length && this.active < this.workers.length && this.reserved + this.waiting[0]!.bytes <= this.opts.memoryBytes) {
      const w = this.waiting.shift()!;
      this.active++;
      this.reserved += w.bytes;
      w.go();
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
