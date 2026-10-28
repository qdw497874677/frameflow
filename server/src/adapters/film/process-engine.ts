/**
 * FilmEngine 适配器：把 engine/ 的 frameflow-film 当子进程跑，stdin/stdout 走 FFE1 帧。
 *
 * - 懒启动：第一次请求才拉起，启动握手 hello 校验协议版本
 * - 串行队列：一个进程一次一个请求（引擎内部自己多线程）
 * - 超时：单个请求超时就杀进程（流里可能还有半帧，不能复用），下个请求重新拉起
 * - 熔断：短时间内连续崩溃就冷却一段时间直接报错，不疯狂重启
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FilmEngine, FilmEngineHealth, FilmRenderRequest } from '../../application/grading/ports.ts';
import type { FilmParams, FilmStock } from '../../domain/grading/film.ts';
import { lutFromEngine } from '../../domain/grading/film.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import { encodeFrame, FrameDecoder, type EngineFrame } from './codec.ts';

export const ENGINE_PROTOCOL = 1;

export interface ProcessEngineOptions {
  readonly binary: string;
  readonly args?: readonly string[];
  /** 单个请求超时（毫秒） */
  readonly timeoutMs?: number;
  /** 启动握手超时（毫秒） */
  readonly startTimeoutMs?: number;
  /** 熔断：windowMs 内崩溃 maxCrashes 次就冷却 cooldownMs */
  readonly maxCrashes?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

interface Pending {
  resolve: (f: EngineFrame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ProcessFilmEngine implements FilmEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private inflight = 0;
  private crashes: number[] = [];
  private stderrTail = '';
  private closed = false;
  private state: FilmEngineHealth['state'] = 'idle';
  private ver: string | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly opts: ProcessEngineOptions;

  constructor(opts: ProcessEngineOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  version(): string | null { return this.ver; }

  health(): FilmEngineHealth {
    return { state: this.state, version: this.ver, restarts: this.restarts, lastError: this.lastError };
  }

  async stocks(): Promise<FilmStock[]> {
    const { header } = await this.request({ op: 'list_stocks' });
    const items = header['stocks'];
    if (!Array.isArray(items)) throw new EngineError('bad_response', 'list_stocks 没有 stocks');
    return items.map((s: Record<string, unknown>) => ({
      id: String(s['id']), name: String(s['name']), inspiredBy: String(s['inspiredBy'] ?? ''),
      kind: s['kind'] === 'paper' ? 'paper' : 'negative',
    }));
  }

  async bakeLut(req: { stock: string; paper?: string; size: number; params?: FilmParams }): Promise<Lut3D> {
    const { header, payload } = await this.request({ op: 'bake_lut', stock: req.stock, ...(req.paper ? { paper: req.paper } : {}), size: req.size, params: req.params ?? {} });
    const size = Number(header['size']);
    if (payload.length !== size ** 3 * 12) throw new EngineError('bad_response', `bake_lut 载荷长度不对：${payload.length}`);
    const f32 = new Float32Array(size ** 3 * 3);
    for (let i = 0; i < f32.length; i++) f32[i] = payload.readFloatLE(i * 4);
    return lutFromEngine(size, f32);
  }

  /** 整帧渲染（rgb8）；超时缺省用 timeoutMs，池子会按像素数传更长的 */
  async render(req: FilmRenderRequest, timeoutMs?: number): Promise<Uint8Array> {
    const n = req.width * req.height * 3;
    if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || req.width < 1 || req.height < 1 || req.pixels.length !== n) {
      throw new EngineError('bad_request', `render 尺寸与像素长度不符：${req.width}×${req.height}，${req.pixels.length} 字节`);
    }
    const { payload } = await this.request({
      op: 'render', stock: req.stock, ...(req.paper ? { paper: req.paper } : {}),
      width: req.width, height: req.height, format: 'rgb8', params: req.params ?? {},
    }, req.pixels, timeoutMs);
    if (payload.length !== n) throw new EngineError('bad_response', `render 载荷长度不对：${payload.length}`);
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  /** 排队中 + 进行中的请求数（池子挑最闲的进程用） */
  load(): number { return this.inflight; }

  /** 任意请求（串行）；ok:false 抛 EngineError(code) */
  request(header: Record<string, unknown>, payload?: Uint8Array, timeoutMs?: number): Promise<EngineFrame> {
    this.inflight++;
    const run = this.queue.then(() => this.exchange(header, payload, timeoutMs ?? this.opts.timeoutMs ?? 30_000)).finally(() => { this.inflight--; });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try { child.stdin.write(encodeFrame({ op: 'shutdown', id: 0 })); child.stdin.end(); } catch { /* 已经断了 */ }
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(timer);
  }

  private async exchange(header: Record<string, unknown>, payload: Uint8Array | undefined, timeoutMs: number): Promise<EngineFrame> {
    if (this.closed) throw new EngineError('closed', '胶片引擎已关闭');
    await this.ensureStarted();
    const frame = await this.send(header, payload, timeoutMs);
    if (frame.header['ok'] !== true) {
      const err = (frame.header['error'] ?? {}) as Record<string, unknown>;
      throw new EngineError(String(err['code'] ?? 'internal'), String(err['message'] ?? '引擎报错'));
    }
    return frame;
  }

  private send(header: Record<string, unknown>, payload: Uint8Array | undefined, timeoutMs: number): Promise<EngineFrame> {
    const child = this.child;
    if (!child) return Promise.reject(new EngineError('down', '胶片引擎没在运行'));
    const id = this.nextId++;
    return new Promise<EngineFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.fail(`请求超时（${timeoutMs} ms）：${String(header['op'])}`);
        child.kill('SIGKILL');
        reject(new EngineError('timeout', `胶片引擎 ${String(header['op'])} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      child.stdin.write(encodeFrame({ ...header, id }, payload));
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.child && this.state === 'up') return Promise.resolve();
    if (this.starting) return this.starting;
    const since = this.now() - (this.opts.windowMs ?? 60_000);
    this.crashes = this.crashes.filter((t) => t >= since);
    if (this.crashes.length >= (this.opts.maxCrashes ?? 3)) {
      const last = this.crashes[this.crashes.length - 1]!;
      if (this.now() - last < (this.opts.cooldownMs ?? 30_000)) {
        return Promise.reject(new EngineError('down', `胶片引擎连续崩溃，冷却中：${this.lastError ?? ''}`));
      }
      this.crashes = [];
    }
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.state !== 'idle') this.restarts++;
    this.state = 'starting';
    this.stderrTail = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.binary, [...(this.opts.args ?? [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.fail(`启动失败：${(e as Error).message}`);
      throw new EngineError('down', this.lastError!);
    }
    this.child = child;
    const decoder = new FrameDecoder();
    child.stdout.on('data', (chunk: Buffer) => {
      let frames: EngineFrame[];
      try { frames = decoder.push(chunk); } catch (e) {
        this.fail((e as Error).message);
        child.kill('SIGKILL');
        return;
      }
      for (const f of frames) {
        const p = this.pending;
        if (!p) continue;
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(f);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000); });
    child.stdin.on('error', () => undefined);
    const onGone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.closed) { this.state = 'down'; return; }
      this.crashes.push(this.now());
      this.fail(`${why}${this.stderrTail ? `：${this.stderrTail.trim().split('\n').pop()}` : ''}`);
      const p = this.pending;
      this.pending = null;
      if (p) { clearTimeout(p.timer); p.reject(new EngineError('down', `胶片引擎退出了：${this.lastError}`)); }
    };
    child.on('error', (e) => onGone(`进程错误：${e.message}`));
    child.on('exit', (code, signal) => onGone(`进程退出（${signal ?? code}）`));

    const hello = await this.send({ op: 'hello' }, undefined, this.opts.startTimeoutMs ?? 10_000);
    if (hello.header['ok'] !== true || Number(hello.header['protocol']) !== ENGINE_PROTOCOL) {
      child.kill('SIGKILL');
      this.fail(`协议不匹配：要 ${ENGINE_PROTOCOL}，引擎是 ${String(hello.header['protocol'])}`);
      throw new EngineError('protocol', this.lastError!);
    }
    this.ver = String(hello.header['version'] ?? '?');
    this.state = 'up';
    this.lastError = null;
  }

  private fail(message: string): void {
    this.state = 'down';
    this.lastError = message;
  }
}
