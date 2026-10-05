/**
 * 假照片生成器：浏览器内 canvas 现场画图（无外部素材、零网络）。
 * 只在 mock 数据源里使用；真实数据来自后端预览管线。
 */

export type FocusKind = 'sharp' | 'soft' | 'miss';

export interface MockSpec {
  seed: number;
  ar: number; // 宽高比 w/h
  pal: readonly [string, string, string];
  focus: FocusKind;
}

export const PALETTES: readonly (readonly [string, string, string])[] = [
  ['#1a2b4a', '#3d5a80', '#98c1d9'],
  ['#2d1b2e', '#6b2737', '#e8a87c'],
  ['#0d2818', '#2d6a4f', '#b7e4c7'],
  ['#33272a', '#7f4f24', '#a68a64'],
  ['#0b2545', '#13315c', '#8da9c4'],
  ['#2f1b0e', '#a44a3f', '#f4c095'],
];

export function mulberry(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一张假照片（返回 JPEG data URL）。同一 (seed,width) 结果稳定。 */
export function renderMockPhoto(spec: MockSpec, width: number): string {
  const h = Math.max(8, Math.round(width / spec.ar));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = h;
  const x = c.getContext('2d');
  if (!x) return '';
  const rnd = mulberry(spec.seed);
  const [sky, mid, lit] = spec.pal;

  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sky);
  g.addColorStop(0.62, mid);
  g.addColorStop(0.63, lit);
  g.addColorStop(1, '#0a0a0f');
  x.fillStyle = g;
  x.fillRect(0, 0, width, h);

  // 月亮
  x.fillStyle = 'rgba(255,240,200,.9)';
  x.beginPath();
  x.arc(width * (0.3 + rnd() * 0.4), h * 0.2 + rnd() * 0.15, width * 0.018 + 4, 0, 7);
  x.fill();

  // 山脊三层
  for (let L = 0; L < 3; L++) {
    x.fillStyle = `rgba(${20 + L * 14},${24 + L * 14},${34 + L * 16},${0.9 - L * 0.18})`;
    x.beginPath();
    x.moveTo(0, h * 0.63);
    let y = h * (0.58 + rnd() * 0.06);
    for (let px = 0; px <= width; px += width / 14) {
      y += (rnd() - 0.5) * h * 0.09;
      y = Math.max(h * 0.4, Math.min(h * 0.66, y));
      x.lineTo(px, y);
    }
    x.lineTo(width, h);
    x.lineTo(0, h);
    x.fill();
  }

  // 草地
  x.strokeStyle = `rgba(${180 + rnd() * 40},${170 + rnd() * 30},120,.8)`;
  const blades = width * (h / 400) * 2.2;
  for (let b = 0; b < blades; b++) {
    const gx = rnd() * width;
    const gy = h * 0.68 + rnd() * h * 0.32;
    const len = (4 + rnd() * 14) * (width / 800);
    x.lineWidth = 0.8 * (width / 800);
    x.beginPath();
    x.moveTo(gx, gy);
    x.lineTo(gx + (rnd() - 0.5) * len * 2, gy - len);
    x.stroke();
  }

  // 前景枝干
  x.strokeStyle = 'rgba(8,8,12,.92)';
  const tx = width * (0.08 + rnd() * 0.84);
  for (let b = 0; b < 7; b++) {
    let bx = tx;
    let by = h * 0.64;
    let ang = -1.2 - rnd() * 0.5;
    const len = h * 0.1 * (width / 800);
    x.lineWidth = 2 * (width / 800);
    x.beginPath();
    x.moveTo(bx, by);
    for (let s = 0; s < 6; s++) {
      bx += Math.cos(ang) * len * 2;
      by += Math.sin(ang) * len * 2;
      x.lineTo(bx, by);
      ang += (rnd() - 0.5) * 0.8;
    }
    x.stroke();
  }

  // 颗粒
  x.globalAlpha = 0.05;
  const grains = (width * h) / 900;
  for (let n = 0; n < grains; n++) {
    x.fillStyle = rnd() > 0.5 ? '#fff' : '#000';
    x.fillRect(rnd() * width, rnd() * h, 1, 1);
  }
  x.globalAlpha = 1;

  // 假对焦：整体软 / 局部跑焦
  const applyBlur = (cx: number, cy: number, r: number, px: number) => {
    x.save();
    x.beginPath();
    x.arc(cx, cy, r, 0, 7);
    x.clip();
    x.filter = `blur(${px}px)`;
    x.drawImage(c, 0, 0);
    x.restore();
    x.filter = 'none';
  };
  if (spec.focus === 'soft') applyBlur(width / 2, h / 2, Math.max(width, h), 2.2 * (width / 800));
  if (spec.focus === 'miss') {
    const r = 0.16 + rnd() * 0.14;
    applyBlur(
      width * (0.25 + rnd() * 0.5),
      h * (0.45 + rnd() * 0.3),
      Math.min(width, h) * r,
      3.4 * (width / 800),
    );
  }

  return c.toDataURL('image/jpeg', 0.82);
}
