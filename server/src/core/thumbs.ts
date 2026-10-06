/**
 * 缩略图与预览来源（票 001 的分层管线）。
 *
 *  1. 有外拍 JPEG → 直接用它（`external_jpeg`，最清晰、最便宜）
 *  2. 没有 → 从 RAW 抽内嵌 JPEG（`JpgFromRaw` → `PreviewImage` → `ThumbnailImage`），抽出来的那份缓存起来
 *  3. 都失败 → 目前返回「无法生成预览」（LibRaw 兜底是下一步：本机没有 LibRaw 绑定，且它只影响
 *     少数机型的内嵌缩略图过小的情况）
 *
 * 缓存**全在服务端本地**（`dataDir`），不写回照片目录 —— 库在 NAS 上，写小文件到共享很慢，
 * 而且照片目录只该有用户自己的东西。
 *
 * 缓存文件名为 `<路径哈希>_<源文件签名>_<尺寸>.jpg`：源文件一改（mtime/size 变），新的缓存文件出现，
 * 旧的不会命中；清理是后台 GC 的事（现在不做，缓存可重建）。
 */

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { extractEmbeddedJpeg } from './exif.ts';
import type { PhotoRecord, PreviewSource } from './photo.ts';

export class PreviewUnavailable extends Error {
  readonly photoId: string;

  constructor(photoId: string, reason?: string) {
    super(reason ?? '无法生成预览：没有外拍 JPEG，也抽不出内嵌 JPEG');
    this.photoId = photoId;
  }
}

/** RAW 侧预览缓存的键（scan 也要用它判断「抽过了没有」，所以放在模块级） */
export function previewKey(absStem: string, sig: string): string {
  return `${createHash('sha1').update(absStem).digest('hex').slice(0, 16)}_${sig}.jpg`;
}

/**
 * sharp 能直接解码的格式。**HEIC 不在里面** —— 这个 sharp 构建的 heif 只注册了 `.avif`
 * （HEVC 解码有专利问题，发行版常关掉），拿 HEIC 当 JPEG 直接丢给 sharp 会 500。
 * 所以别的「图像」一律走内嵌预览抽取（exiftool），抽不出来才回绝。
 */
const DIRECT_EXTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.tif', '.tiff', '.avif']);

function directlyDecodable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot > 0 && DIRECT_EXTS.has(path.slice(dot).toLowerCase());
}

export class Thumbs {
  private readonly previewDir: string;
  private readonly thumbDir: string;

  constructor(dataDir: string) {
    this.previewDir = join(dataDir, 'previews');
    this.thumbDir = join(dataDir, 'thumbs');
    mkdirSync(this.previewDir, { recursive: true });
    mkdirSync(this.thumbDir, { recursive: true });
  }

  /** 源签名：用哪个文件出预览，就按哪个文件的 mtime+size 判新旧 */
  sourceSig(rec: PhotoRecord): string {
    const src = rec.jpeg ?? rec.raw;
    return `${Math.floor(src?.mtimeMs ?? 0)}-${src?.size ?? 0}`;
  }

  /** 抽出来的内嵌预览在缓存里的位置（scan 用它判断预览来源） */
  previewCachePath(absStem: string, sig: string): string {
    return join(this.previewDir, previewKey(absStem, sig));
  }

  private absStemOf(rec: PhotoRecord): string {
    const src = rec.jpeg ?? rec.raw;
    if (!src) throw new PreviewUnavailable(rec.id);
    return src.path.slice(0, src.path.length - (src.ext?.length ?? 0));
  }

  /** 预览的「母版」：外拍 JPEG 本身，或抽出来的内嵌 JPEG（落盘缓存）。 */
  async master(rec: PhotoRecord): Promise<{ path: string; source: PreviewSource }> {
    // 视频既没有 raw 也没有 jpeg：封面要 ffmpeg 抽帧，还没做（见地图「视频预览边界」）。
    // 这里必须显式回绝 —— 掉进下面的 raw/jpeg 假设会变成 500。
    if (rec.kind === 'video' && !rec.jpeg) throw new PreviewUnavailable(rec.id, '视频封面还没做（ffmpeg 抽帧见地图「视频预览边界」）');
    // 外拍 JPEG：最清晰也最便宜 —— 但只有 sharp 真能解的那种才直接给它
    if (rec.jpeg && existsSync(rec.jpeg.path) && directlyDecodable(rec.jpeg.path)) {
      return { path: rec.jpeg.path, source: 'external_jpeg' };
    }

    const cached = this.previewCachePath(this.absStemOf(rec), this.sourceSig(rec));
    if (existsSync(cached)) return { path: cached, source: 'embedded_jpeg' };

    const buf = await extractEmbeddedJpeg(rec.previewPath);
    if (!buf) throw new PreviewUnavailable(rec.id);
    const tmp = `${cached}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, cached);
    return { path: cached, source: 'embedded_jpeg' };
  }

  async thumb(rec: PhotoRecord, size: 512 | 2048): Promise<{ path: string; etag: string; source: PreviewSource }> {
    const { path: src, source } = await this.master(rec);
    const etag = createHash('sha1').update(`${src}|${this.sourceSig(rec)}|${size}`).digest('hex').slice(0, 24);
    const out = join(this.thumbDir, `${etag}.jpg`);

    if (!existsSync(out) || statSync(out).size === 0) {
      const tmp = `${out}.${process.pid}.tmp`;
      await sharp(src, { failOn: 'none', unlimited: false })
        .rotate() // 按 EXIF 朝向摆正，然后丢掉该标记
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: size > 512 ? 86 : 80, mozjpeg: true })
        .toFile(tmp);
      renameSync(tmp, out);
    }
    return { path: out, etag, source };
  }
}
