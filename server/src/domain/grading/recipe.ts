/**
 * 配方：一张照片在风格阶段里「套什么风格、什么参数」。任务级默认 + 逐张覆盖，合并规则只在这里。
 *
 * 任务参数里存 `recipe: { lookId, kind, params }`（params 按风格类型的参数模式，见 look-kind.ts）。
 * 兼容旧任务：`look` / `strength` / `film`（胶片整帧效果）三个旧字段读进来时折算成同样的配方。
 */
import type { LookParams, ParamValue } from './look-kind.ts';

export interface Look {
  readonly id: string;
  readonly name: string;
  /** 近似的胶卷（只作说明，非官方） */
  readonly inspiredBy: string;
}

export interface Recipe {
  /** null = 这张不套用 */
  readonly look: string | null;
  readonly strength: number;
}

export interface RecipeOverride {
  look?: string | null;
  strength?: number;
}

export const DEFAULT_STRENGTH = 1;

export function isValidStrength(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function resolveRecipe(defaults: Recipe, override?: RecipeOverride | null): Recipe {
  return {
    look: override && override.look !== undefined ? override.look : defaults.look,
    strength: override?.strength ?? defaults.strength,
  };
}

/** 导出文件名：`原名_风格.jpg`；不套用的就是 `原名.jpg` */
export function exportName(displayName: string, look: string | null): string {
  const stem = displayName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  return look ? `${stem}_${look}.jpg` : `${stem}.jpg`;
}

export interface LookRecipe {
  readonly lookId: string | null;
  /** 风格类型；旧任务没有，按 lookId 查注册表补 */
  readonly kind?: string;
  readonly params: LookParams;
}

const LEGACY_FILM_KEYS = ['grain', 'grainSeed', 'halation', 'halationRadiusMm', 'dirDiffusionUm', 'filmFormatMm'] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 任务参数 → 配方：新字段 `recipe` 优先；否则把旧的 look / strength / film 折算进来 */
export function recipeFromParams(params: Record<string, unknown>): LookRecipe {
  const r = params['recipe'];
  if (isObj(r)) {
    return {
      lookId: typeof r['lookId'] === 'string' ? r['lookId'] : null,
      ...(typeof r['kind'] === 'string' ? { kind: r['kind'] } : {}),
      params: isObj(r['params']) ? (r['params'] as LookParams) : {},
    };
  }
  return legacyRecipe(params);
}

/** 旧字段（`look` / `strength` / `film{...}`）→ 配方；film 里的效果键与 film 类型参数同名 */
export function legacyRecipe(src: Record<string, unknown>): LookRecipe {
  const out: Record<string, ParamValue> = {};
  if (src['strength'] !== undefined) out['strength'] = src['strength'] as number;
  const film = src['film'];
  if (isObj(film)) for (const k of LEGACY_FILM_KEYS) if (film[k] !== undefined) out[k] = film[k] as number;
  return { lookId: typeof src['look'] === 'string' ? src['look'] : null, params: out };
}

export function hasLegacyFields(src: Record<string, unknown>): boolean {
  return src['look'] !== undefined || src['strength'] !== undefined || src['film'] !== undefined;
}
