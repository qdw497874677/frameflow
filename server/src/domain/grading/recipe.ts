/** 配方：一张照片在滤镜阶段里「套什么、套多重」。任务级默认 + 逐张覆盖，合并规则只在这里。 */

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
