/**
 * 风格（Look）与风格类型（LookKind）：
 *
 * - 风格 = 用户在 UI 里挑的那一项（「Portrait 400 · 光谱」「Vivid 100」）。
 * - 风格类型 = 风格背后的实现路径（`lut`：内置 .cube；`film`：光谱胶片引擎）。
 *   每个类型用一份**参数模式**声明自己支持哪些配置项（数值 / 枚举 / 开关 / 颜色 / 种子，分组），
 *   自己校验、自己规范化；可组合的附加效果（边框、暗角、颗粒…）由支持它的类型自己挂上，不是全局写死。
 * - 配方存 `{ lookId, kind, params }`；前端按模式自动渲染配置面板。
 *
 * 纯数据 + 纯函数，不知道 HTTP、引擎和磁盘。见 docs/adr/0006-look-and-look-kind.md。
 */

/** 参数在预览里怎么体现：`lut` = 烘进预览 LUT；`approx` = 预览用 CSS/WebGL 近似；`export` = 只在导出出现 */
export type ParamPreview = 'lut' | 'approx' | 'export';

interface ParamBase {
  readonly key: string;
  readonly label: string;
  /** 所属分组 id（见 LookKindSchema.groups） */
  readonly group: string;
  readonly hint?: string;
  readonly preview: ParamPreview;
}

export interface NumberParam extends ParamBase { readonly type: 'number'; readonly min: number; readonly max: number; readonly step: number; readonly default: number; readonly unit?: string; readonly integer?: boolean }
export interface EnumParam extends ParamBase { readonly type: 'enum'; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hint?: string }>; readonly default: string }
export interface BoolParam extends ParamBase { readonly type: 'bool'; readonly default: boolean }
export interface ColorParam extends ParamBase { readonly type: 'color'; readonly default: string }
/** 随机种子：缺省 = 按照片派生（同一张重导一致） */
export interface SeedParam extends ParamBase { readonly type: 'seed' }

export type ParamDescriptor = NumberParam | EnumParam | BoolParam | ColorParam | SeedParam;
export type ParamValue = number | string | boolean;
export type LookParams = Readonly<Record<string, ParamValue>>;

export interface ParamGroup {
  readonly id: string;
  readonly label: string;
  /** 可组合的附加效果（边框 / 暗角 / 颗粒…）：UI 折叠展示 */
  readonly extra?: boolean;
  readonly hint?: string;
}

export interface LookKindSchema {
  readonly kind: string;
  readonly label: string;
  readonly groups: readonly ParamGroup[];
  readonly params: readonly ParamDescriptor[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const SEED_MAX = 4294967295;

function problemOf(d: ParamDescriptor, v: unknown): string | null {
  switch (d.type) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || v < d.min || v > d.max) return `${d.key} 要在 ${d.min}–${d.max} 之间`;
      if (d.integer && !Number.isInteger(v)) return `${d.key} 要是整数`;
      return null;
    case 'enum':
      return typeof v === 'string' && d.options.some((o) => o.value === v) ? null : `${d.key} 只能是 ${d.options.map((o) => o.value).join(' / ')}`;
    case 'bool':
      return typeof v === 'boolean' ? null : `${d.key} 是布尔值`;
    case 'color':
      return typeof v === 'string' && HEX.test(v) ? null : `${d.key} 是 #rrggbb 颜色`;
    case 'seed':
      return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= SEED_MAX ? null : `${d.key} 是 0–${SEED_MAX} 的整数`;
  }
}

/** 按模式校验参数（空 = 合法）；不认识的键也算错，免得拼错了悄悄不生效 */
export function paramProblems(schema: LookKindSchema, params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [`${schema.kind} 风格的 params 是对象`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const d = schema.params.find((p) => p.key === k);
    if (!d) { out.push(`${schema.label}不支持参数：${k}`); continue; }
    const p = problemOf(d, v);
    if (p) out.push(p);
  }
  return out;
}

/** 规范化：丢掉本类型不认识或不合法的键（换风格类型时旧参数不跟过去），颜色统一小写 */
export function normalizeParams(schema: LookKindSchema, params: unknown): LookParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, ParamValue> = {};
  for (const d of schema.params) {
    const v = (params as Record<string, unknown>)[d.key];
    if (v === undefined || problemOf(d, v)) continue;
    out[d.key] = d.type === 'color' ? (v as string).toLowerCase() : (v as ParamValue);
  }
  return out;
}

/** 参数取值（缺省回落到模式默认；seed 没默认 = undefined） */
export function paramValue<T extends ParamValue>(schema: LookKindSchema, params: LookParams, key: string): T | undefined {
  if (params[key] !== undefined) return params[key] as T;
  const d = schema.params.find((p) => p.key === key);
  return d && d.type !== 'seed' ? (d.default as T) : undefined;
}

/** 只取某类预览方式的参数（如烘 LUT 用的 `lut` 参数），用来做缓存键 / 预览 URL */
export function paramsFor(schema: LookKindSchema, params: LookParams, preview: ParamPreview): LookParams {
  const keys = new Set(schema.params.filter((p) => p.preview === preview).map((p) => p.key));
  return Object.fromEntries(Object.entries(params).filter(([k]) => keys.has(k)));
}

// ---- 可组合的附加效果：由支持它的风格类型自己挂进模式 ----

export const STRENGTH_PARAM: NumberParam = { key: 'strength', label: '强度', group: 'look', type: 'number', min: 0, max: 1, step: 0.05, default: 1, preview: 'lut', hint: '0 = 原图，1 = 完全套用' };

export const BORDER_RATIOS = ['original', '1:1', '4:5', '3:2', '16:9'] as const;

/** 边框 / 画框：导出时服务端按像素加边；预览用 CSS 近似 */
export function borderExtra(): { group: ParamGroup; params: ParamDescriptor[] } {
  return {
    group: { id: 'border', label: '边框', extra: true, hint: '导出时在成品四周加边，可补成固定画幅；预览为近似' },
    params: [
      { key: 'borderWidth', label: '边宽', group: 'border', type: 'number', min: 0, max: 0.25, step: 0.01, default: 0, preview: 'approx', hint: '占短边的比例，0 = 无边框' },
      { key: 'borderColor', label: '边框颜色', group: 'border', type: 'color', default: '#ffffff', preview: 'approx' },
      { key: 'borderRatio', label: '画幅', group: 'border', type: 'enum', default: 'original', preview: 'approx', hint: '加边后补成的画幅（按照片横竖方向）',
        options: BORDER_RATIOS.map((v) => ({ value: v, label: v === 'original' ? '跟原图' : v })) },
    ],
  };
}

/** 暗角：导出按像素算，预览用 CSS 径向渐变近似 */
export function vignetteExtra(): { group: ParamGroup; params: ParamDescriptor[] } {
  return {
    group: { id: 'lens', label: '镜头', extra: true, hint: '暗角：四角压暗' },
    params: [{ key: 'vignette', label: '暗角', group: 'lens', type: 'number', min: 0, max: 1, step: 0.05, default: 0, preview: 'approx', hint: '0 = 关' }],
  };
}

export function composeSchema(base: { kind: string; label: string; groups: ParamGroup[]; params: ParamDescriptor[] }, ...extras: Array<{ group: ParamGroup; params: ParamDescriptor[] }>): LookKindSchema {
  return {
    kind: base.kind,
    label: base.label,
    groups: [...base.groups, ...extras.map((e) => e.group)],
    params: [...base.params, ...extras.flatMap((e) => e.params)],
  };
}
