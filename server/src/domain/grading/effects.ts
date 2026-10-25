/**
 * 效果管线：一张图的像素依次过一串 Effect。LUT 是第一个实现；颗粒、光晕、水印以后各加一个 Effect，
 * 阶段与渲染器都不用改（渲染器只认 `Effect`）。
 */
import { sampleLut, type Lut3D } from './lut.ts';

export interface Effect {
  readonly id: string;
  /** 原地改写交错排列的 8 位像素（channels ≥ 3，多出来的 alpha 不动） */
  apply(pixels: Uint8Array, channels: number): void;
}

/** 按强度把 LUT 结果和原色混合（strength 0 = 原图，1 = 完全套用） */
export function lutEffect(lut: Lut3D, strength: number): Effect {
  const k = Math.min(1, Math.max(0, strength));
  return {
    id: 'lut',
    apply(pixels, channels) {
      if (k === 0) return;
      const out = new Float32Array(3);
      for (let i = 0; i + 2 < pixels.length; i += channels) {
        const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        sampleLut(lut, r / 255, g / 255, b / 255, out);
        pixels[i] = Math.round(r + (out[0]! * 255 - r) * k);
        pixels[i + 1] = Math.round(g + (out[1]! * 255 - g) * k);
        pixels[i + 2] = Math.round(b + (out[2]! * 255 - b) * k);
      }
    },
  };
}

export function runEffects(pixels: Uint8Array, channels: number, effects: readonly Effect[]): void {
  for (const effect of effects) effect.apply(pixels, channels);
}
