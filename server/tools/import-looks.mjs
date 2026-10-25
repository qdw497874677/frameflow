#!/usr/bin/env node
// 把 HaldCLUT PNG 转成 33³ .cube，写进 assets/looks/。只在更新内置风格时手动跑：
//   node tools/import-looks.mjs <hald-png-dir>
// 目录里按风格 id 命名：portrait160.png …（来源与许可见 assets/looks/NOTICE）
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SIZE = 33;
const dir = process.argv[2];
if (!dir) { console.error('用法：node tools/import-looks.mjs <hald-png-dir>'); process.exit(2); }
const out = path.join(import.meta.dirname, '..', 'assets', 'looks');
const looks = JSON.parse(fs.readFileSync(path.join(out, 'looks.json'), 'utf8'));

for (const look of looks) {
  const { data, info } = await sharp(path.join(dir, `${look.id}.png`)).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const level = Math.round(Math.cbrt(info.width));
  const n = level * level; // 每个通道的格数
  if (level ** 3 !== info.width || info.width !== info.height) throw new Error(`${look.id}: 不是 HaldCLUT`);
  const at = (r, g, b, c) => data[(r + g * n + b * n * n) * info.channels + c] / 255;
  const lines = [`TITLE "${look.name}"`, `# ${look.inspiredBy}，由 RawTherapee Film Simulation HaldCLUT 转换（CC BY-SA 4.0）`, `LUT_3D_SIZE ${SIZE}`];
  for (let b = 0; b < SIZE; b++) for (let g = 0; g < SIZE; g++) for (let r = 0; r < SIZE; r++) {
    const f = [r, g, b].map((v) => (v / (SIZE - 1)) * (n - 1));
    const i0 = f.map((v) => Math.min(Math.floor(v), n - 2));
    const d = f.map((v, k) => v - i0[k]);
    const rgb = [0, 1, 2].map((c) => {
      let acc = 0;
      for (let k = 0; k < 8; k++) {
        const o = [k & 1, (k >> 1) & 1, (k >> 2) & 1];
        const w = o.reduce((p, oi, j) => p * (oi ? d[j] : 1 - d[j]), 1);
        acc += w * at(i0[0] + o[0], i0[1] + o[1], i0[2] + o[2], c);
      }
      return acc.toFixed(6);
    });
    lines.push(rgb.join(' '));
  }
  fs.writeFileSync(path.join(out, `${look.id}.cube`), `${lines.join('\n')}\n`);
  console.log(`${look.id}: HaldCLUT level ${level} → ${SIZE}³`);
}
