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

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { touchIfStale } from './cache.ts';
import { extractEmbeddedJpeg } from './exif.ts';
import type { PhotoRecord, PreviewSource } from './photo.ts';

const run = promisify(execFile);

export class PreviewUnavailable extends Error {
  readonly photoId: string;

  constructor(photoId: string, reason?: string) {
    super(reason ?? '无法生成预览：没有外拍 JPEG，也抽不出内嵌 JPEG');
    this.photoId = photoId;
  }
}

/**
 * 一次最多几个 ffmpeg 抽帧。
 * 挂载失联时每个抽帧都会卡到超时：没有闸，进一次网格就会同时起几十个卡死的子进程（票 011 现场是 4 个）。
 */
const FFMPEG_CONCURRENCY = 2;
/** 连续失败这么多次就暂时不再抽：源大概整体不可用，别一个个等到超时 */
const POSTER_BREAKER_FAILURES = 3;
const POSTER_BREAKER_MS = 5 * 60_000;

/** 简单的并发闸：超出 limit 的排队，先到先服务 */
class Gate {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resume) => this.waiting.push(resume));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** 存在性检查走异步：照片目录可能在网络挂载上，同步检查撞上挂死的挂载会冻住事件循环 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
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
  /** 正在抽的视频封面：同一个视频的并发请求共用一次 ffmpeg */
  private readonly posters = new Map<string, Promise<{ path: string; source: PreviewSource }>>();
  /** 正在写盘的缓存文件：容量淘汰不能删它们（票 013） */
  private readonly inflight = new Set<string>();
  private readonly ffmpegGate = new Gate(FFMPEG_CONCURRENCY);
  /** 连续抽帧失败计数 + 熔断到什么时候 */
  private posterFailures = 0;
  private posterBlockedUntil = 0;

  constructor(dataDir: string) {
    this.previewDir = join(dataDir, 'previews');
    this.thumbDir = join(dataDir, 'thumbs');
    mkdirSync(this.previewDir, { recursive: true });
    mkdirSync(this.thumbDir, { recursive: true });
  }

  /** 缓存落在哪两个目录（容量策略要扫它们） */
  cacheDirs(): string[] {
    return [this.previewDir, this.thumbDir];
  }

  /** 现在不能删的缓存文件（正在生成 / 正在被写） */
  protectedPaths(): Set<string> {
    const set = new Set(this.inflight);
    for (const path of this.posters.keys()) set.add(path);
    return set;
  }

  /** 源签名：用哪个文件出预览，就按哪个文件的 mtime+size 判新旧 */
  sourceSig(rec: PhotoRecord): string {
    const src = rec.jpeg ?? rec.raw ?? rec.video;
    return `${Math.floor(src?.mtimeMs ?? 0)}-${src?.size ?? 0}`;
  }

  /** 抽出来的内嵌预览在缓存里的位置（scan 用它判断预览来源） */
  previewCachePath(absStem: string, sig: string): string {
    return join(this.previewDir, previewKey(absStem, sig));
  }

  private absStemOf(rec: PhotoRecord): string {
    const src = rec.jpeg ?? rec.raw ?? rec.video;
    if (!src) throw new PreviewUnavailable(rec.id);
    return src.path.slice(0, src.path.length - (src.ext?.length ?? 0));
  }

  /** 预览的「母版」：外拍 JPEG 本身，或抽出来的内嵌 JPEG（落盘缓存）。 */
  async master(rec: PhotoRecord): Promise<{ path: string; source: PreviewSource }> {
    // 视频：没有 raw/jpeg，封面由 ffmpeg 抽帧（缓存到 dataDir，不写回照片目录）
    if (rec.kind === 'video' || (!rec.jpeg && !rec.raw && rec.video)) return this.poster(rec);
    // 外拍 JPEG：最清晰也最便宜 —— 但只有 sharp 真能解的那种才直接给它
    if (rec.jpeg && directlyDecodable(rec.jpeg.path) && (await isFile(rec.jpeg.path))) {
      return { path: rec.jpeg.path, source: 'external_jpeg' };
    }

    const cached = this.previewCachePath(this.absStemOf(rec), this.sourceSig(rec));
    if (existsSync(cached)) {
      void touchIfStale(cached); // 抽出来的预览也是缓存，被用到就刷新 LRU
      return { path: cached, source: 'embedded_jpeg' };
    }

    const buf = await extractEmbeddedJpeg(rec.previewPath);
    if (!buf) throw new PreviewUnavailable(rec.id);
    const tmp = `${cached}.${process.pid}.tmp`;
    this.inflight.add(cached);
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, cached);
    } finally {
      this.inflight.delete(cached);
    }
    return { path: cached, source: 'embedded_jpeg' };
  }

  /**
   * 视频封面：ffmpeg 抽第 1 秒的一帧（不到 1 秒的短片退回第 0 帧），落进预览缓存。
   * 并发请求共用一次抽帧 —— 一个目录里几十个视频，网格会同时要好几十张。
   */
  private async poster(rec: PhotoRecord): Promise<{ path: string; source: PreviewSource }> {
    const cached = this.previewCachePath(this.absStemOf(rec), this.sourceSig(rec));
    if (existsSync(cached)) {
      void touchIfStale(cached);
      return { path: cached, source: 'video_poster' };
    }
    if (Date.now() < this.posterBlockedUntil) {
      throw new PreviewUnavailable(rec.id, '视频封面暂缓：源挂载似乎不可用，稍后自动重试');
    }
    const inflight = this.posters.get(cached);
    if (inflight) return inflight;
    const job = this.makePoster(rec, cached).finally(() => this.posters.delete(cached));
    this.posters.set(cached, job);
    return job;
  }

  private async makePoster(rec: PhotoRecord, cached: string): Promise<{ path: string; source: PreviewSource }> {
    const tmp = `${cached}.${process.pid}.tmp`;
    let lastErr: unknown;
    for (const seek of [['-ss', '1'], []] as string[][]) {
      try {
        unlinkSync(tmp);
      } catch {
        // 上一轮没产物
      }
      try {
        await this.ffmpegGate.run(() =>
          run(
            'ffmpeg',
            [
              '-hide_banner', '-loglevel', 'error', '-nostdin', ...seek,
              '-i', rec.previewPath,
              '-frames:v', '1', '-an', '-vf', 'scale=min(2048\\,iw):-2', '-q:v', '4',
              '-f', 'mjpeg', '-y', tmp,
            ],
            { timeout: 120_000 },
          ),
        );
        if (existsSync(tmp) && statSync(tmp).size > 0) {
          renameSync(tmp, cached);
          this.posterFailures = 0;
          return { path: cached, source: 'video_poster' };
        }
      } catch (err) {
        lastErr = err;
      }
    }
    this.notePosterFailure();
    throw new PreviewUnavailable(rec.id, `视频封面抽帧失败：${lastErr instanceof Error ? lastErr.message : 'ffmpeg 没给出帧'}`);
  }

  /** 连续失败到阈值就熔断几分钟：整库不可用时不该逐个请求去等超时 */
  private notePosterFailure(): void {
    if (++this.posterFailures >= POSTER_BREAKER_FAILURES) {
      this.posterBlockedUntil = Date.now() + POSTER_BREAKER_MS;
      this.posterFailures = 0;
    }
  }

  async thumb(rec: PhotoRecord, size: 512 | 2048): Promise<{ path: string; etag: string; source: PreviewSource }> {
    const { path: src, source } = await this.master(rec);
    const etag = createHash('sha1').update(`${src}|${this.sourceSig(rec)}|${size}`).digest('hex').slice(0, 24);
    const out = join(this.thumbDir, `${etag}.jpg`);

    if (!existsSync(out) || statSync(out).size === 0) {
      const tmp = `${out}.${process.pid}.tmp`;
      this.inflight.add(out);
      try {
        await sharp(src, { failOn: 'none', unlimited: false })
          .rotate() // 按 EXIF 朝向摆正，然后丢掉该标记
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: size > 512 ? 86 : 80, mozjpeg: true })
          .toFile(tmp);
        renameSync(tmp, out);
      } finally {
        this.inflight.delete(out);
      }
    } else {
      void touchIfStale(out); // 命中缓存：刷新 LRU，别让常用缩略图先被淘汰
    }
    return { path: out, etag, source };
  }
}
