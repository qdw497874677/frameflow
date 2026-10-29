/** 附加效果的像素实现（导出用）：暗角、边框。纯计算；预览端用 CSS 近似同一组参数。 */
import type { Effect } from './effects.ts';

export interface BorderSpec {
  /** 每边边宽占短边的比例 */
  readonly width: number;
  readonly color: string;
  /** 'original' 或 'a:b'（长:短，按照片横竖方向套用） */
  readonly ratio: string;
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 加边后的画布尺寸与原图偏移：先四周等宽加边，再沿短缺方向补到目标画幅（原图居中） */
export function borderLayout(w: number, h: number, spec: BorderSpec): { width: number; height: number; x: number; y: number } {
  const b = Math.round(Math.min(w, h) * Math.max(0, spec.width));
  let W = w + 2 * b, H = h + 2 * b;
  const m = /^(\d+):(\d+)$/.exec(spec.ratio);
  if (m) {
    const long = Math.max(+m[1]!, +m[2]!), short = Math.min(+m[1]!, +m[2]!);
    const r = W >= H ? long / short : short / long; // 目标 W/H
    if (W / H > r) H = Math.round(W / r);
    else W = Math.round(H * r);
  }
  return { width: W, height: H, x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2) };
}

export function hasBorder(spec: BorderSpec): boolean {
  return spec.width > 0 || spec.ratio !== 'original';
}

export function borderEffect(spec: BorderSpec): Effect {
  const [r, g, b] = rgbOf(spec.color);
  return {
    id: 'border',
    apply(pixels, channels, frame) {
      if (!frame) throw new Error('边框需要整帧尺寸');
      const L = borderLayout(frame.width, frame.height, spec);
      const out = new Uint8Array(L.width * L.height * channels);
      for (let i = 0; i < out.length; i += channels) { out[i] = r; out[i + 1] = g; out[i + 2] = b; if (channels > 3) out[i + 3] = 255; }
      const row = frame.width * channels;
      for (let y = 0; y < frame.height; y++) out.set(pixels.subarray(y * row, (y + 1) * row), ((y + L.y) * L.width + L.x) * channels);
      return { pixels: out, width: L.width, height: L.height };
    },
  };
}

/** 暗角：按到中心的归一化距离做平滑压暗，amount 1 ≈ 角落 −1.5 EV */
export function vignetteEffect(amount: number): Effect {
  const k = Math.min(1, Math.max(0, amount));
  return {
    id: 'vignette',
    apply(pixels, channels, frame) {
      if (!frame || k === 0) return;
      const { width: w, height: h } = frame;
      const cx = (w - 1) / 2, cy = (h - 1) / 2, rr = Math.hypot(cx, cy) || 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - cx, y - cy) / rr;
          const t = Math.min(1, Math.max(0, (d - 0.35) / 0.65));
          const gain = 1 - k * 0.65 * t * t * (3 - 2 * t);
          const i = (y * w + x) * channels;
          pixels[i] = Math.round(pixels[i]! * gain); pixels[i + 1] = Math.round(pixels[i + 1]! * gain); pixels[i + 2] = Math.round(pixels[i + 2]! * gain);
        }
      }
    },
  };
}
