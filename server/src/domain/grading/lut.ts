/**
 * 3D LUT（.cube）：解析、序列化与三线性插值。纯计算，浏览器预览（WebGL2）与服务端导出读同一份文件。
 *
 * 数据布局沿用 .cube 约定：红最快、蓝最慢，`index = r + g·N + b·N²`，每格 3 个 0–1 浮点。
 */

export interface Lut3D {
  readonly size: number;
  /** 长度 size³ × 3 */
  readonly table: Float32Array;
}

export class LutParseError extends Error {}

export function parseCube(text: string): Lut3D {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (/^[A-Za-z]/.test(line)) continue; // TITLE / DOMAIN_MIN / DOMAIN_MAX：只支持默认 0–1 域
    for (const part of line.split(/\s+/)) values.push(Number(part));
  }
  if (!Number.isInteger(size) || size < 2 || size > 128) throw new LutParseError(`LUT_3D_SIZE 不合法：${size}`);
  if (values.length !== size ** 3 * 3) throw new LutParseError(`数据行数不对：要 ${size ** 3} 行，实际 ${values.length / 3}`);
  if (values.some((v) => !Number.isFinite(v))) throw new LutParseError('数据里有非数字');
  return { size, table: Float32Array.from(values) };
}

export function formatCube(lut: Lut3D, title: string): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.table.length; i += 3) {
    lines.push(`${lut.table[i]!.toFixed(6)} ${lut.table[i + 1]!.toFixed(6)} ${lut.table[i + 2]!.toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 单位 LUT（不改颜色）：测试与「原图」用 */
export function identityLut(size: number): Lut3D {
  const table = new Float32Array(size ** 3 * 3);
  const max = size - 1;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const i = (r + g * size + b * size * size) * 3;
    table[i] = r / max;
    table[i + 1] = g / max;
    table[i + 2] = b / max;
  }
  return { size, table };
}

/** 三线性插值查表：输入输出都是 0–1 */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number, out: Float32Array | number[] = [0, 0, 0]): Float32Array | number[] {
  const n = lut.size;
  const max = n - 1;
  const fr = clamp01(r) * max, fg = clamp01(g) * max, fb = clamp01(b) * max;
  const r0 = Math.min(Math.floor(fr), max - 1), g0 = Math.min(Math.floor(fg), max - 1), b0 = Math.min(Math.floor(fb), max - 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const t = lut.table;
  for (let c = 0; c < 3; c++) {
    const at = (ri: number, gi: number, bi: number) => t[(ri + gi * n + bi * n * n) * 3 + c]!;
    const c00 = at(r0, g0, b0) * (1 - dr) + at(r0 + 1, g0, b0) * dr;
    const c10 = at(r0, g0 + 1, b0) * (1 - dr) + at(r0 + 1, g0 + 1, b0) * dr;
    const c01 = at(r0, g0, b0 + 1) * (1 - dr) + at(r0 + 1, g0, b0 + 1) * dr;
    const c11 = at(r0, g0 + 1, b0 + 1) * (1 - dr) + at(r0 + 1, g0 + 1, b0 + 1) * dr;
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
