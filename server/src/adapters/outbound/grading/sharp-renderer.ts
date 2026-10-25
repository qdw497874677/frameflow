/**
 * Renderer：sharp 读全尺寸源（RAW 用内嵌 JPEG，与看片台同源）→ 按 EXIF 摆正 → 取 sRGB 像素跑效果管线 → JPEG。
 * vips 没有 3D LUT，所以像素在 domain 的 Effect 里算；换 ffmpeg lut3d 只需另写一个 Renderer。
 */
import sharp from 'sharp';
import { runEffects, type Effect } from '../../../domain/grading/effects.ts';
import type { PhotoRecord } from '../../../domain/photo.ts';
import type { Renderer } from '../../../application/grading/ports.ts';

export interface MasterSource {
  get(id: string): PhotoRecord | undefined;
  readonly thumbs: { master(rec: PhotoRecord): Promise<{ path: string }> };
}

export class SharpRenderer implements Renderer {
  private readonly lib: MasterSource;
  private readonly quality: number;

  constructor(lib: MasterSource, opts: { quality?: number } = {}) {
    this.lib = lib;
    this.quality = opts.quality ?? 92;
  }

  async render(photoId: string, effects: readonly Effect[]): Promise<Uint8Array> {
    const rec = this.lib.get(photoId);
    if (!rec) throw new Error(`照片不在库里了：${photoId}`);
    const { path } = await this.lib.thumbs.master(rec);
    const { data, info } = await sharp(path).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    runEffects(pixels, info.channels, effects);
    const out = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels as 3 } })
      .withIccProfile('srgb')
      .jpeg({ quality: this.quality, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
}
