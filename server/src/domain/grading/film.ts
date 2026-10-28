/**
 * 光谱胶片引擎（engine/，独立 C++ 进程）在领域里的样子：胶片、渲染参数、风格 id 规则、LUT 缓存键。
 * 纯计算，不知道进程、协议和磁盘。
 */
import type { Lut3D } from './lut.ts';

export interface FilmStock {
  readonly id: string;
  readonly name: string;
  /** 数据来源的胶卷（只作说明，非官方） */
  readonly inspiredBy: string;
  readonly kind: 'negative' | 'paper';
}

/** 与引擎协议 params 一一对应；缺省值由引擎决定 */
export interface FilmParams {
  readonly exposureEv?: number;
  readonly sceneKelvin?: number;
  readonly printerKelvin?: number;
  readonly viewingKelvin?: number;
  readonly printGrey?: number;
  readonly dirStrength?: number;
  readonly scanBlackPoint?: boolean;
  /** 显示参考输入的反 OOTF γ（1 = 场景线性） */
  readonly inputGamma?: number;
  /** 镜头杂散光，场景白的比例 */
  readonly cameraFlare?: number;
}

const RANGES: Record<Exclude<keyof FilmParams, 'scanBlackPoint'>, readonly [number, number]> = {
  exposureEv: [-6, 6],
  sceneKelvin: [2000, 12000],
  printerKelvin: [2000, 12000],
  viewingKelvin: [2000, 12000],
  printGrey: [0.05, 0.5],
  dirStrength: [0, 2],
  inputGamma: [1, 2],
  cameraFlare: [0, 0.1],
};

/**
 * 只在整帧渲染里有的胶片效果（依赖邻域像素，进不了 3D LUT）：颗粒、光晕、DIR 边缘效应。
 * 与引擎 render 的同名参数一一对应；全缺省（或都是 0）= 关，导出走 LUT，与以前一样。
 */
export interface FilmEffects {
  /** 颗粒大小倍数，0 = 关；1 ≈ ISO 400 彩负 */
  readonly grain?: number;
  /** 颗粒种子（同种子同尺寸结果一致） */
  readonly grainSeed?: number;
  /** 光晕强度（片基反射比例），0 = 关 */
  readonly halation?: number;
  /** 光晕在胶片上的半径（mm） */
  readonly halationRadiusMm?: number;
  /** DIR 抑制剂扩散长度（µm），0 = 关 */
  readonly dirDiffusionUm?: number;
  /** 画幅长边（mm，135 = 36），决定颗粒与光晕的像素尺度 */
  readonly filmFormatMm?: number;
}

export const FILM_EFFECT_RANGES: Record<keyof FilmEffects, readonly [number, number]> = {
  grain: [0, 4],
  grainSeed: [0, 4294967295],
  halation: [0, 1],
  halationRadiusMm: [0.02, 2],
  dirDiffusionUm: [0, 100],
  filmFormatMm: [8, 300],
};

/** 效果参数问题列表（空 = 合法）；与引擎端校验一致 */
export function filmEffectProblems(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    const range = FILM_EFFECT_RANGES[k as keyof FilmEffects];
    if (!range) { out.push(`不认识的效果参数：${k}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) out.push(`${k} 要在 ${range[0]}–${range[1]} 之间`);
    else if (k === 'grainSeed' && !Number.isInteger(v)) out.push('grainSeed 要是整数');
  }
  return out;
}

/** 有没有真正打开的效果（只有它们才需要整帧渲染；全关就走 LUT） */
export function hasFilmEffects(e: FilmEffects | null | undefined): boolean {
  return !!e && ((e.grain ?? 0) > 0 || (e.halation ?? 0) > 0 || (e.dirDiffusionUm ?? 0) > 0);
}

/** 整帧渲染的工作内存估计（引擎约 50 B/像素 + 进出各 3 B + 进程间拷贝），给内存闸门用 */
export function filmRenderBytes(width: number, height: number): number {
  return width * height * 64;
}

/** 参数问题列表（空 = 合法）；与引擎端校验一致，越界在进程外就挡掉 */
export function filmParamProblems(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'scanBlackPoint') {
      if (typeof v !== 'boolean') out.push('scanBlackPoint 要是布尔值');
      continue;
    }
    const range = RANGES[k as keyof typeof RANGES];
    if (!range) { out.push(`不认识的参数：${k}`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) out.push(`${k} 要在 ${range[0]}–${range[1]} 之间`);
  }
  return out;
}

/** 风格 id：`film` + 胶片 id（只留小写字母数字，与 .cube 路由的 id 规则一致；加前缀避开同名内置 .cube） */
export const FILM_LOOK_PREFIX = 'film';
export function filmLookId(stockId: string): string {
  return FILM_LOOK_PREFIX + stockId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 烘焙结果的缓存键：引擎版本 + 胶片 + 相纸 + 尺寸 + 参数（键排序，结果确定） */
export function filmLutKey(engineVersion: string, stock: string, paper: string | null, size: number, params: FilmParams): string {
  const p = Object.keys(params).sort().map((k) => `${k}=${String(params[k as keyof FilmParams])}`).join(',');
  return `${engineVersion}|${stock}|${paper ?? ''}|${size}|${p}`;
}

/** 引擎 bake_lut 的 f32 载荷（红最快、sRGB 编码）→ Lut3D；值截到 0–1 */
export function lutFromEngine(size: number, data: Float32Array): Lut3D {
  if (!Number.isInteger(size) || size < 2) throw new Error(`LUT 尺寸不合法：${size}`);
  if (data.length !== size ** 3 * 3) throw new Error(`LUT 数据长度不对：要 ${size ** 3 * 3}，实际 ${data.length}`);
  const table = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    if (!Number.isFinite(v)) throw new Error('LUT 数据里有非数字');
    table[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return { size, table };
}

/**
 * 100% 裁切预览的几何：在 fullW×fullH 的整帧里，以 (cx, cy)（0–1）为中心取 size×size，
 * 四周补 ≈3σ（光晕 / DIR 扩散，按整帧像素间距折算）免得边缘效果被裁掉；
 * 裁出来的区域长边变短，所以底片长边要按比例缩，才能保持与整帧导出相同的像素间距（颗粒与光晕尺度一致）。
 */
export interface CropPlan {
  /** 交给引擎渲染的区域（含补边） */
  readonly region: { left: number; top: number; width: number; height: number };
  /** 渲染后再从 region 里裁回的可见块 */
  readonly visible: { left: number; top: number; width: number; height: number };
  /** 渲染 region 时用的 filmFormatMm */
  readonly filmFormatMm: number;
}

export function filmCropPlan(fullW: number, fullH: number, cx: number, cy: number, size: number, fx: FilmEffects): CropPlan {
  const long = Math.max(fullW, fullH);
  const format = fx.filmFormatMm ?? 36;
  const pitchUm = (format * 1000) / long;
  const reachUm = Math.max((fx.halation ?? 0) > 0 ? (fx.halationRadiusMm ?? 0.25) * 1000 : 0, fx.dirDiffusionUm ?? 0);
  const pad = Math.min(Math.ceil((3 * reachUm) / pitchUm), 2 * size);
  const w = Math.min(size, fullW), h = Math.min(size, fullH);
  const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const vl = clampTo(Math.round(cx * fullW - w / 2), 0, fullW - w);
  const vt = clampTo(Math.round(cy * fullH - h / 2), 0, fullH - h);
  const left = Math.max(0, vl - pad), top = Math.max(0, vt - pad);
  const right = Math.min(fullW, vl + w + pad), bottom = Math.min(fullH, vt + h + pad);
  const region = { left, top, width: right - left, height: bottom - top };
  return {
    region,
    visible: { left: vl - left, top: vt - top, width: w, height: h },
    filmFormatMm: Math.max(0.001, (format * Math.max(region.width, region.height)) / long),
  };
}
