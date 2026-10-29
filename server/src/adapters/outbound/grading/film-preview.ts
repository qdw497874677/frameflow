/**
 * 100% 裁切预览：从全尺寸源（与导出同源）裁一块，补边后交给整帧效果（引擎颗粒 / 光晕 / DIR）渲染，
 * 再裁回可见块出 JPEG。底片长边按裁切比例缩小，像素间距与整帧导出一致，颗粒与光晕尺度相同。
 * 颗粒的具体图样与整帧导出不逐像素一致（随机场按渲染区域生成），统计特征一致。
 */
import sharp from 'sharp';
import { filmCropPlan, type FilmEffects } from '../../../domain/grading/film.ts';
import { lutEffect, runEffects, type Effect } from '../../../domain/grading/effects.ts';
import type { LookSource } from '../../../application/grading/ports.ts';
import type { LookParams } from '../../../domain/grading/look-kind.ts';
import type { MasterSource } from './sharp-renderer.ts';

export interface FilmPreviewRequest {
  readonly photoId: string;
  readonly look: string;
  readonly strength: number;
  readonly film: FilmEffects;
  /** 烘 LUT 的风格参数（相纸 / 预设 / 曝光） */
  readonly variant?: LookParams;
  /** 裁切中心（0–1，相对摆正后的整帧） */
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
}

export class FilmCropPreview {
  private readonly lib: MasterSource;
  private readonly looks: LookSource;
  constructor(lib: MasterSource, looks: LookSource) { this.lib = lib; this.looks = looks; }

  /** null = 照片或风格不存在 */
  async render(req: FilmPreviewRequest): Promise<{ jpeg: Uint8Array; ms: number } | null> {
    const t0 = Date.now();
    const rec = this.lib.get(req.photoId);
    if (!rec) return null;
    const { path } = await this.lib.thumbs.master(rec);
    const meta = await sharp(path).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const fullW = (swap ? meta.height : meta.width) ?? 0, fullH = (swap ? meta.width : meta.height) ?? 0;
    if (!fullW || !fullH) throw new Error('读不出原图尺寸');
    const plan = filmCropPlan(fullW, fullH, req.cx, req.cy, req.size, req.film);
    const { data, info } = await sharp(path).rotate().extract(plan.region).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let effect: Effect | null = this.looks.frameEffect?.(req.look, req.strength, { ...req.film, filmFormatMm: plan.filmFormatMm }, req.variant) ?? null;
    if (!effect) {
      const lut = await this.looks.load(req.look, req.variant);
      if (!lut) return null;
      effect = lutEffect(lut, req.strength);
    }
    await runEffects(pixels, info.channels, [effect], { width: info.width, height: info.height });
    const out = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels as 3 } })
      .extract(plan.visible)
      .withIccProfile('srgb')
      .jpeg({ quality: 90 })
      .toBuffer();
    return { jpeg: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), ms: Date.now() - t0 };
  }
}
