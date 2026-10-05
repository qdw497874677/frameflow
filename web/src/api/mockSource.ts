import type { ListPhotosOptions, PhotoPage, PhotoSource } from './source';
import { PALETTES, mulberry, renderMockPhoto, type FocusKind, type MockSpec } from './mock/render';
import type { FolderListing, MarkInput, MarkResult, OpResult, Photo } from '../core/types';

/**
 * Mock 数据源：浏览器内假照片 + 假目录树。
 * 目的是让交互（尤其手势/物理）能在没有后端的情况下开发到位；
 * 一旦后端可用，把 api/index.ts 切到 httpSource 即可，UI 不改。
 */

const CAMS = ['Sony A7M4 · 24-70', 'Fuji X-T5 · 35 1.4', 'Ricoh GR3', 'iPhone 15 Pro'];
const COUNT = 60;

interface MockRecord extends MockSpec {
  id: string;
  dir: string;
  displayName: string;
  camera: string;
  hasRaw: boolean;
  hasJpeg: boolean;
  focus: FocusKind;
  mtime: string;
}

/** mock 目录树刻意长成用户的真实习惯：项目 → 设备 → 照片|视频 → 原始|修改后 */
const MOCK_ROOT = '/photos/2026-冰岛';
const MOCK_TREE: Record<string, string[]> = {
  '/photos': ['2026-冰岛', '2026-街拍', '待整理'],
  [MOCK_ROOT]: ['A7M4', 'X-T5'],
  [`${MOCK_ROOT}/A7M4`]: ['照片', '视频'],
  [`${MOCK_ROOT}/A7M4/照片`]: ['原始', '修改后'],
};

function buildRecords(dir: string): MockRecord[] {
  const rnd = mulberry(20260905);
  const out: MockRecord[] = [];
  for (let i = 0; i < COUNT; i++) {
    const r = rnd();
    const ar = r < 0.6 ? 1.5 : r < 0.9 ? 2 / 3 : 1; // 横 3:2 / 竖 2:3 / 方
    const fr = rnd();
    const focus: FocusKind = fr < 0.45 ? 'sharp' : fr < 0.6 ? 'soft' : 'miss';
    const hasRaw = rnd() > 0.15; // 多数是 RAW+JPEG 双出
    out.push({
      id: `mock-${i}`,
      dir,
      displayName: `_DSC${(1042 + i * 3).toString().padStart(4, '0')}`,
      camera: CAMS[i % CAMS.length],
      hasRaw,
      hasJpeg: true,
      seed: 1000 + i,
      ar,
      pal: PALETTES[i % PALETTES.length],
      focus,
      mtime: new Date(Date.UTC(2026, 8, 5, 10, i % 60)).toISOString(),
    });
  }
  return out;
}

function toPhoto(rec: MockRecord): Photo {
  return {
    id: rec.id,
    dir: rec.dir,
    displayName: rec.displayName,
    kind: 'photo',
    ar: rec.ar,
    camera: rec.camera,
    lens: null,
    hasRaw: rec.hasRaw,
    hasJpeg: rec.hasJpeg,
    rawPath: rec.hasRaw ? `${rec.dir}/${rec.displayName}.ARW` : null,
    jpegPath: `${rec.dir}/${rec.displayName}.JPG`,
    capturedAt: rec.mtime,
    mtime: rec.mtime,
    sizeBytes: rec.hasRaw ? 52_000_000 : 9_000_000,
    preview: rec.hasJpeg ? 'external_jpeg' : rec.hasRaw ? 'embedded_jpeg' : 'pending',
    focusHint: rec.focus,
    mark: { stars: 0, del: false },
  };
}

export function createMockSource(): PhotoSource {
  const records = buildRecords(MOCK_ROOT);
  const byId = new Map(records.map((r) => [r.id, r]));
  const cache = new Map<string, string>();
  const trashed = new Set<string>();

  const thumbUrl = (photoId: string, size: 512 | 2048) => {
    const rec = byId.get(photoId);
    if (!rec) return '';
    const key = `${rec.id}:${size}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const url = renderMockPhoto(rec, size);
    cache.set(key, url);
    return url;
  };

  return {
    kind: 'mock',

    async listFolders(path = '/photos'): Promise<FolderListing> {
      const children = MOCK_TREE[path] ?? [];
      const parent = path === '/photos' ? null : path.slice(0, path.lastIndexOf('/')) || '/photos';
      return {
        path,
        parent,
        folders: children.map((name) => ({
          name,
          path: `${path}/${name}`,
          photoCount: (MOCK_TREE[`${path}/${name}`] ?? []).length ? undefined : COUNT,
          hasSubfolders: Boolean(MOCK_TREE[`${path}/${name}`]?.length),
        })),
        photoCount: path === MOCK_ROOT ? COUNT : 0,
      };
    },

    async listPhotos(opts: ListPhotosOptions): Promise<PhotoPage> {
      // 目录树里只有叶子节点有照片；其余目录返回空列表（模拟真实下钻）
      const items = opts.dir === MOCK_ROOT ? records.map(toPhoto) : [];
      return { items, total: items.length, nextCursor: null };
    },

    thumbUrl,

    async saveMarks(items: MarkInput[]): Promise<MarkResult[]> {
      return items.map((i) => ({ id: i.id, ok: true, error: null }));
    },

    async moveToTrash(ids: string[]): Promise<OpResult> {
      ids.forEach((id) => trashed.add(id));
      return { ok: ids.length, failed: [] };
    },

    async restore(ids: string[]): Promise<OpResult> {
      ids.forEach((id) => trashed.delete(id));
      return { ok: ids.length, failed: [] };
    },
  };
}
