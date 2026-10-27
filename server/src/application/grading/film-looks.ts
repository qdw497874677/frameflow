/**
 * 光谱胶片风格：把引擎里的每个负片做成一个风格（负片 + 默认相纸），导出与预览都用烘焙好的 33³ LUT，
 * 与内置 .cube 走同一条 Effect 管线。
 *
 * 降级顺序：缓存命中（同引擎版本 + 参数）→ 让引擎烘焙并落盘 → 引擎不可用时用任意版本的旧缓存 → null。
 */
import type { FilmParams, FilmStock } from '../../domain/grading/film.ts';
import { filmLookId, filmLutKey } from '../../domain/grading/film.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import type { Look } from '../../domain/grading/recipe.ts';
import type { FilmEngine, FilmLutStore, LookSource } from './ports.ts';

export interface FilmLookOptions {
  readonly lutSize?: number;
  readonly paper?: string;
  readonly params?: FilmParams;
}

export class FilmLookSource implements LookSource {
  private stocksById = new Map<string, FilmStock>();
  private looks: Look[] = [];
  private papers: FilmStock[] = [];
  private readonly memo = new Map<string, Lut3D>();
  private readonly pending = new Map<string, Promise<Lut3D | null>>();
  readonly lutSize: number;
  private readonly engine: FilmEngine;
  private readonly store: FilmLutStore;
  private readonly opts: FilmLookOptions;

  constructor(engine: FilmEngine, store: FilmLutStore, opts: FilmLookOptions = {}) {
    this.engine = engine;
    this.store = store;
    this.opts = opts;
    this.lutSize = opts.lutSize ?? 33;
  }

  /** 启动时调一次：问引擎有哪些胶片；引擎不在就用上次的目录。永不抛错 */
  async refresh(): Promise<{ from: 'engine' | 'cache' | 'none'; error?: string }> {
    try {
      const stocks = await this.engine.stocks();
      this.setCatalog(stocks);
      await this.store.writeCatalog(stocks).catch(() => undefined);
      return { from: 'engine' };
    } catch (e) {
      const cached = await this.store.readCatalog().catch(() => null);
      if (cached) this.setCatalog(cached);
      return { from: cached ? 'cache' : 'none', error: (e as Error).message };
    }
  }

  private setCatalog(stocks: readonly FilmStock[]): void {
    this.stocksById = new Map();
    this.papers = stocks.filter((s) => s.kind === 'paper');
    this.looks = [];
    for (const s of stocks) {
      if (s.kind !== 'negative') continue;
      const id = filmLookId(s.id);
      this.stocksById.set(id, s);
      this.looks.push({ id, name: `${s.name} · 光谱`, inspiredBy: s.inspiredBy });
    }
  }

  list(): Look[] {
    return this.looks.map((l) => ({ ...l }));
  }

  has(id: string): boolean {
    return this.stocksById.has(id);
  }

  async load(id: string): Promise<Lut3D | null> {
    const stock = this.stocksById.get(id);
    if (!stock) return null;
    const paper = this.opts.paper ?? this.papers[0]?.id ?? null;
    const params = this.opts.params ?? {};
    const version = this.engine.version();
    const key = filmLutKey(version ?? '?', stock.id, paper, this.lutSize, params);
    const hit = version ? this.memo.get(key) : undefined;
    if (hit) return hit;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const run = this.resolve(stock.id, paper, params, version, key).finally(() => this.pending.delete(key));
    this.pending.set(key, run);
    return run;
  }

  private async resolve(stock: string, paper: string | null, params: FilmParams, version: string | null, key: string): Promise<Lut3D | null> {
    // 稳定键（不含版本）指向最近一次成功烘焙，作为降级来源
    const fallbackKey = filmLutKey('latest', stock, paper, this.lutSize, params);
    if (version) {
      const cached = await this.store.read(key).catch(() => null);
      if (cached) { this.memo.set(key, cached); return cached; }
    }
    try {
      const lut = await this.engine.bakeLut({ stock, ...(paper ? { paper } : {}), size: this.lutSize, params });
      const realKey = filmLutKey(this.engine.version() ?? '?', stock, paper, this.lutSize, params);
      this.memo.set(realKey, lut);
      await Promise.all([this.store.write(realKey, lut), this.store.write(fallbackKey, lut)]).catch(() => undefined);
      return lut;
    } catch {
      return this.store.read(fallbackKey).catch(() => null);
    }
  }
}
