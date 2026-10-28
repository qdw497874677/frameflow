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
