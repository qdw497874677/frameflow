/**
 * 光谱胶片风格：把引擎里的每个负片做成一个风格（负片 + 默认相纸），导出与预览都用烘焙好的 33³ LUT，
 * 与内置 .cube 走同一条 Effect 管线。
 *
 * 降级顺序：缓存命中（同引擎版本 + 参数）→ 让引擎烘焙并落盘 → 引擎不可用时用任意版本的旧缓存 → null。
 */
import type { FilmEffects, FilmParams, FilmStock } from '../../domain/grading/film.ts';
import { filmLookId, filmLutKey, hasFilmEffects } from '../../domain/grading/film.ts';
import { blendRgb, toRgb, type Effect } from '../../domain/grading/effects.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import type { Look } from '../../domain/grading/recipe.ts';
import type { FilmEngine, FilmLutStore, LookSource } from './ports.ts';
import type { LookParams } from '../../domain/grading/look-kind.ts';
import { FILM_PRESETS, filmRenderParams, type FilmPreset } from '../../domain/grading/film-presets.ts';

export const DEFAULT_PAPER = 'premierpaper';

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
    // 缺省相纸 = 列表第一张：Premier（最早接入、所有基准用它）排最前，其余按引擎顺序
    this.papers = stocks.filter((s) => s.kind === 'paper').sort((a, b) => Number(b.id === DEFAULT_PAPER) - Number(a.id === DEFAULT_PAPER));
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

  /** 整帧渲染效果：引擎从原图整帧算（色彩 + 颗粒 / 光晕 / DIR 边缘），再按强度混回。失败就抛（导出会重试 / 记失败） */
  /** 可选的相纸（给 film 风格类型的 paper 枚举） */
  paperList(): FilmStock[] {
    return this.papers.map((p) => ({ ...p }));
  }

  /** 引擎 id（不带 film 前缀） */
  stockOf(id: string): string | null {
    return this.stocksById.get(id)?.id ?? null;
  }

  /** variant（相纸 / 预设 / 曝光）→ 相纸 + 引擎参数；没给 variant = 配置里的固定相纸与参数（老行为） */
  private variantOf(stockId: string, variant?: LookParams): { paper: string | null; params: FilmParams } {
    const base = this.opts.params ?? {};
    const want = variant?.['paper'];
    const paper = typeof want === 'string' && this.papers.some((p) => p.id === want) ? want : this.opts.paper ?? this.papers[0]?.id ?? null;
    if (!variant) return { paper, params: base };
    const preset = FILM_PRESETS.includes(variant['preset'] as FilmPreset) ? (variant['preset'] as FilmPreset) : 'neutral';
    const ev = typeof variant['exposureEv'] === 'number' ? variant['exposureEv'] : 0;
    return { paper, params: { ...base, ...filmRenderParams(stockId, preset, ev) } };
  }

  frameEffect(id: string, strength: number, film: FilmEffects, variant?: LookParams): Effect | null {
    const stock = this.stocksById.get(id);
    if (!stock || !hasFilmEffects(film)) return null;
    const v = this.variantOf(stock.id, variant);
    const paper = v.paper ?? undefined;
    const params = { ...v.params, ...film };
    const engine = this.engine;
    return {
      id: 'film-render',
      async apply(pixels, channels, frame) {
        if (!frame) throw new Error('整帧胶片效果需要整帧尺寸');
        const out = await engine.render({ stock: stock.id, ...(paper ? { paper } : {}), width: frame.width, height: frame.height, pixels: toRgb(pixels, channels), params });
        blendRgb(pixels, channels, out, strength);
      },
    };
  }

  async load(id: string, variant?: LookParams): Promise<Lut3D | null> {
    const stock = this.stocksById.get(id);
    if (!stock) return null;
    const { paper, params } = this.variantOf(stock.id, variant);
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
