/**
 * 风格类型注册表：每个风格（Look）由一个风格类型（LookKind）承载 —— `lut`（内置 .cube）、`film`（光谱胶片引擎）…
 * 类型声明自己的参数模式、自己校验 / 规范化、自己把参数组装成导出效果管线。
 * 加一种新类型 = 写一个 LookKind + 一个 LookSource，在组装根注册；grade 任务、API、前端面板都不用改。
 */
import { lutEffect, type Effect } from '../../domain/grading/effects.ts';
import { borderEffect, hasBorder, vignetteEffect, type BorderSpec } from '../../domain/grading/frame-extras.ts';
import { FILM_EFFECT_RANGES, hasFilmEffects, type FilmEffects } from '../../domain/grading/film.ts';
import { FILM_PRESETS, FILM_PRESET_LABELS } from '../../domain/grading/film-presets.ts';
import {
  borderExtra, composeSchema, normalizeParams, paramProblems, paramValue, STRENGTH_PARAM, vignetteExtra,
  type LookKindSchema, type LookParams,
} from '../../domain/grading/look-kind.ts';
import type { Look } from '../../domain/grading/recipe.ts';
import type { FilmLookSource } from './film-looks.ts';
import type { LookSource } from './ports.ts';

export interface EffectContext {
  /** 照片派生的种子（颗粒等随机效果：同一张重导一致） */
  readonly seed: number;
}

export interface LookKind {
  readonly kind: string;
  /** 参数模式（可以是动态的：如 film 的相纸列表来自引擎目录） */
  schema(): LookKindSchema;
  validate(params: unknown): string[];
  normalize(params: unknown): LookParams;
  /** 导出效果管线；风格文件拿不到就抛（导出会重试 / 记失败） */
  effects(lookId: string, params: LookParams, ctx: EffectContext): Promise<Effect[]>;
}

function borderOf(schema: LookKindSchema, p: LookParams): BorderSpec {
  return {
    width: paramValue<number>(schema, p, 'borderWidth') ?? 0,
    color: paramValue<string>(schema, p, 'borderColor') ?? '#ffffff',
    ratio: paramValue<string>(schema, p, 'borderRatio') ?? 'original',
  };
}

abstract class SchemaKind implements LookKind {
  abstract readonly kind: string;
  abstract schema(): LookKindSchema;
  abstract effects(lookId: string, params: LookParams, ctx: EffectContext): Promise<Effect[]>;
  validate(params: unknown): string[] { return paramProblems(this.schema(), params); }
  normalize(params: unknown): LookParams { return normalizeParams(this.schema(), params); }
  protected tail(p: LookParams): Effect[] {
    const s = this.schema();
    const out: Effect[] = [];
    if (s.params.some((d) => d.key === 'vignette')) {
      const v = paramValue<number>(s, p, 'vignette') ?? 0;
      if (v > 0) out.push(vignetteEffect(v));
    }
    if (s.params.some((d) => d.key === 'borderWidth')) {
      const b = borderOf(s, p);
      if (hasBorder(b)) out.push(borderEffect(b));
    }
    return out;
  }
}

/** `lut`：内置 .cube。强度 + 暗角 + 边框 */
export class LutKind extends SchemaKind {
  readonly kind = 'lut';
  private readonly source: LookSource;
  private readonly cached: LookKindSchema;
  constructor(source: LookSource) {
    super();
    this.source = source;
    this.cached = composeSchema({ kind: 'lut', label: 'LUT 风格', groups: [{ id: 'look', label: '风格' }], params: [STRENGTH_PARAM] }, vignetteExtra(), borderExtra());
  }
  schema(): LookKindSchema { return this.cached; }
  async effects(lookId: string, params: LookParams): Promise<Effect[]> {
    const lut = await this.source.load(lookId);
    if (!lut) throw new Error(`风格文件不见了：${lookId}`);
    return [lutEffect(lut, paramValue<number>(this.cached, params, 'strength') ?? 1), ...this.tail(params)];
  }
}

const FILM_EXPORT_KEYS = Object.keys(FILM_EFFECT_RANGES) as Array<keyof FilmEffects>;

/** `film`：光谱胶片引擎。相纸 / 预设 / 曝光烘进 LUT（预览可见）；颗粒 / 光晕 / DIR 只在导出整帧渲染；外加边框 */
export class FilmKind extends SchemaKind {
  readonly kind = 'film';
  private readonly source: FilmLookSource;
  constructor(source: FilmLookSource) { super(); this.source = source; }

  schema(): LookKindSchema {
    const papers = this.source.paperList();
    return composeSchema(
      {
        kind: 'film', label: '光谱胶片',
        groups: [
          { id: 'look', label: '风格' },
          { id: 'print', label: '印放', hint: '相纸、预设与曝光烘进 LUT，预览即所见' },
          { id: 'grain', label: '颗粒', extra: true, hint: '只在导出整帧渲染' },
          { id: 'halation', label: '光晕', extra: true, hint: '只在导出整帧渲染' },
          { id: 'edge', label: '边缘效应', extra: true, hint: '只在导出整帧渲染' },
        ],
        params: [
          STRENGTH_PARAM,
          { key: 'paper', label: '相纸', group: 'print', type: 'enum', preview: 'lut', default: papers[0]?.id ?? 'premierpaper',
            options: (papers.length ? papers : [{ id: 'premierpaper', name: 'Premier Paper', inspiredBy: '' }]).map((p) => ({ value: p.id, label: p.name, hint: p.inspiredBy })) },
          { key: 'preset', label: '预设', group: 'print', type: 'enum', preview: 'lut', default: 'signature',
            options: FILM_PRESETS.map((v) => ({ value: v, label: FILM_PRESET_LABELS[v].label, hint: FILM_PRESET_LABELS[v].hint })) },
          { key: 'exposureEv', label: '曝光补偿', group: 'print', type: 'number', min: -2, max: 2, step: 0.1, default: 0, unit: 'EV', preview: 'lut', hint: '叠加在预设曝光上' },
          { key: 'grain', label: '颗粒', group: 'grain', type: 'number', min: 0, max: 4, step: 0.25, default: 0, preview: 'export', hint: '按胶片 RMS 颗粒度标定；1 = 数据表颗粒度' },
          { key: 'grainSeed', label: '颗粒种子', group: 'grain', type: 'seed', preview: 'export', hint: '缺省按照片派生，重导一致' },
          { key: 'filmFormatMm', label: '画幅长边', group: 'grain', type: 'number', min: 8, max: 120, step: 1, default: 36, unit: 'mm', preview: 'export', hint: '36 = 135 画幅；越小颗粒越显' },
          { key: 'halation', label: '光晕', group: 'halation', type: 'number', min: 0, max: 1, step: 0.05, default: 0, preview: 'export', hint: '高光透过片基反射回乳剂的红晕' },
          { key: 'halationRadiusMm', label: '光晕半径', group: 'halation', type: 'number', min: 0.02, max: 2, step: 0.02, default: 0.25, unit: 'mm', preview: 'export' },
          { key: 'dirDiffusionUm', label: 'DIR 边缘', group: 'edge', type: 'number', min: 0, max: 100, step: 5, default: 0, unit: 'µm', preview: 'export', hint: 'DIR 抑制剂扩散：边缘锐化 / 邻接效应' },
        ],
      },
      borderExtra(),
    );
  }

  /** 烘 LUT 用的那部分参数（相纸 / 预设 / 曝光，缺省补齐），预览 .cube 与导出共用 */
  variant(params: LookParams): LookParams {
    const s = this.schema();
    return { paper: paramValue<string>(s, params, 'paper')!, preset: paramValue<string>(s, params, 'preset')!, exposureEv: paramValue<number>(s, params, 'exposureEv')! };
  }

  /** 只在导出出现的整帧效果（显式给了才算；全 0 = 关） */
  filmEffects(params: LookParams, seed?: number): FilmEffects {
    const out: Record<string, number> = {};
    for (const k of FILM_EXPORT_KEYS) if (typeof params[k] === 'number') out[k] = params[k] as number;
    if (seed !== undefined && out['grainSeed'] === undefined) out['grainSeed'] = seed;
    return out as FilmEffects;
  }

  async effects(lookId: string, params: LookParams, ctx: EffectContext): Promise<Effect[]> {
    const s = this.schema();
    const strength = paramValue<number>(s, params, 'strength') ?? 1;
    const variant = this.variant(params);
    const film = this.filmEffects(params, ctx.seed);
    const frame = hasFilmEffects(film) ? this.source.frameEffect(lookId, strength, film, variant) : null;
    if (frame) return [frame, ...this.tail(params)];
    const lut = await this.source.load(lookId, variant);
    if (!lut) throw new Error(`胶片引擎暂时不可用，也没有缓存：${lookId}`);
    return [lutEffect(lut, strength), ...this.tail(params)];
  }
}

export interface KindedSource { readonly kind: LookKind; readonly source: LookSource }

/** 注册表：风格目录（带类型）+ 按 id 找类型；id 先到先得 */
export class LookKindRegistry {
  private readonly entries_: readonly KindedSource[];
  constructor(entries: readonly KindedSource[]) { this.entries_ = entries; }

  kinds(): LookKindSchema[] {
    const seen = new Set<string>();
    return this.entries_.filter((e) => !seen.has(e.kind.kind) && seen.add(e.kind.kind)).map((e) => e.kind.schema());
  }

  kind(name: string): LookKind | null {
    return this.entries_.find((e) => e.kind.kind === name)?.kind ?? null;
  }

  entries(): Array<Look & { kind: string }> {
    const seen = new Set<string>();
    const out: Array<Look & { kind: string }> = [];
    for (const { kind, source } of this.entries_) {
      for (const look of source.list()) {
        if (seen.has(look.id)) continue;
        seen.add(look.id);
        out.push({ ...look, kind: kind.kind });
      }
    }
    return out;
  }

  /** 这个风格归哪个类型（不认识 = null） */
  kindOf(lookId: string): LookKind | null {
    for (const e of this.entries_) if (e.source.list().some((l) => l.id === lookId)) return e.kind;
    return null;
  }

  sourceOf(lookId: string): LookSource | null {
    for (const e of this.entries_) if (e.source.list().some((l) => l.id === lookId)) return e.source;
    return null;
  }
}
