/**
 * 预览媒体（F20）：只读取 ≤2048 的受控预览（来自 Thumbs 缓存），上传前校验 ≤10MB，
 * 拿不到预览就失败——绝不回退读原片。image_key 按「appId + 源签名」缓存，平台判定失效时重传一次。
 */
import { promises as fsp } from 'node:fs';
import type { FeishuApi } from './client.ts';

export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export class MediaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** 返回 2048 预览路径与源签名（etag）；只能来自预览缓存，不能是原片路径 */
export type PreviewProvider = (photoId: string) => Promise<{ path: string; signature: string }>;

export class MediaUploader {
  readonly #cache = new Map<string, string>();
  readonly #api: FeishuApi;
  readonly #appId: string;
  readonly #preview: PreviewProvider;
  readonly #max: number;
  constructor(o: { api: FeishuApi; appId: string; preview: PreviewProvider; maxBytes?: number }) {
    this.#api = o.api; this.#appId = o.appId; this.#preview = o.preview; this.#max = o.maxBytes ?? PREVIEW_MAX_BYTES;
  }

  async #read(path: string): Promise<Buffer> {
    const fh = await fsp.open(path, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size === 0) throw new MediaError('PREVIEW_UNAVAILABLE');
      if (st.size > this.#max) throw new MediaError('PREVIEW_TOO_LARGE');
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      if (bytesRead !== st.size) throw new MediaError('PREVIEW_UNAVAILABLE');
      return buf;
    } finally { await fh.close(); }
  }

  /** photoId → image_key；force=true 时丢弃缓存重传 */
  async imageKey(photoId: string, force = false): Promise<string> {
    let src: { path: string; signature: string };
    try { src = await this.#preview(photoId); } catch (e) { throw e instanceof MediaError ? e : new MediaError('PREVIEW_UNAVAILABLE'); }
    const key = `${this.#appId}\u0000${src.signature}`;
    if (!force) { const hit = this.#cache.get(key); if (hit) return hit; }
    const bytes = await this.#read(src.path);
    const r = await this.#api.uploadImage(bytes);
    const imageKey = r.code === 0 || r.code === undefined ? r.data?.image_key : undefined;
    if (!imageKey) throw new MediaError(`UPLOAD_FAILED${r.code ? `_${r.code}` : ''}`);
    this.#cache.set(key, imageKey);
    return imageKey;
  }

  invalidate(imageKey: string): void {
    for (const [k, v] of this.#cache) if (v === imageKey) this.#cache.delete(k);
  }
}
