/**
 * 效果管线：一张图的像素依次过一串 Effect。LUT 是第一个实现；颗粒、光晕、水印以后各加一个 Effect，
 * 阶段与渲染器都不用改（渲染器只认 `Effect`）。
 */
import { sampleLut, type Lut3D } from './lut.ts';

export interface Effect {
  readonly id: string;
  /**
   * 原地改写交错排列的 8 位像素（channels ≥ 3，多出来的 alpha 不动）。
   * frame 给整帧尺寸（整帧效果如颗粒 / 光晕要用）；可返回 Promise（交给外部进程算的效果）。
   * 改尺寸的效果（如边框）返回新的 Image，后面的效果接着处理新图。
   */
  apply(pixels: Uint8Array, channels: number, frame?: Frame): void | Image | Promise<void | Image>;
}

export interface Frame { readonly width: number; readonly height: number }
export interface Image extends Frame { readonly pixels: Uint8Array }

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

/** 依次跑完效果；返回最终图像（尺寸可能被边框之类的效果改过） */
export async function runEffects(pixels: Uint8Array, channels: number, effects: readonly Effect[], frame?: Frame): Promise<Image | undefined> {
  let cur = pixels, f = frame;
  for (const effect of effects) {
    const next = await effect.apply(cur, channels, f);
    if (next) { cur = next.pixels; f = { width: next.width, height: next.height }; }
  }
  return f ? { pixels: cur, width: f.width, height: f.height } : undefined;
}

/** 把另算出来的 RGB 成品按强度混回原图（out 为 w×h×3；pixels 可带 alpha） */
export function blendRgb(pixels: Uint8Array, channels: number, out: Uint8Array, strength: number): void {
  const k = Math.min(1, Math.max(0, strength));
  for (let i = 0, j = 0; i + 2 < pixels.length; i += channels, j += 3) {
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c]! + (out[j + c]! - pixels[i + c]!) * k);
  }
}

/** 抽出 RGB（channels = 3 时直接复制） */
export function toRgb(pixels: Uint8Array, channels: number): Uint8Array {
  if (channels === 3) return pixels.slice();
  const n = Math.floor(pixels.length / channels);
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = pixels[i * channels]!; rgb[i * 3 + 1] = pixels[i * channels + 1]!; rgb[i * 3 + 2] = pixels[i * channels + 2]!; }
  return rgb;
}
