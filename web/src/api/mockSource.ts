import type { ListPhotosOptions, PhotoPage, PhotoSource } from './source';
import { PALETTES, mulberry, renderMockPhoto, type FocusKind, type MockSpec } from './mock/render';
import type {
  FolderListing,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  TrashEntry,
} from '../core/types';

/**
 * Mock 数据源：浏览器内假照片 + 假目录树 + 假回收站。
 * 目的是让整套交互（尤其手势/物理、变焦、回收站）能在没有后端的情况下开发到位；
 * 一旦后端可用，把 api/index.ts 切到 httpSource 即可，UI 不改。
 */

const CAMS = ['Sony A7M4 · 24-70', 'Fuji X-T5 · 35 1.4', 'Ricoh GR3', 'iPhone 15 Pro'];
const COUNT = 60;

interface MockRecord extends MockSpec {
  id: string;
  kind: 'photo' | 'video';
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

/** 产品自己的回收站目录（逻辑删除，不动系统废纸篓） */
const TRASH_DIR = '/photos/.trash';

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
      kind: 'photo',
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
  /** 进了回收站的 id（列表里就看不见了） */
  const trashed = new Map<string, TrashEntry>();
  const starsById = new Map<string, number>();
  const delById = new Map<string, boolean>();

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

  const rootsOf = (): Root[] => [
    { id: 'photos', path: '/photos', label: '照片库', photoCount: records.length - trashed.size, online: true },
    { id: 'ssd', path: '/mnt/ssd', label: '移动硬盘', photoCount: undefined, online: false },
  ];

  return {
    kind: 'mock',

    async listRoots() {
      return rootsOf();
    },

    async listFolders(path = '/photos'): Promise<FolderListing> {
      if (path === '/mnt/ssd') {
        return { path, parent: '/photos', folders: [], photoCount: 0 };
      }
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
        photoCount: path === MOCK_ROOT ? records.length - trashed.size : 0,
      };
    },

    async listPhotos(opts: ListPhotosOptions): Promise<PhotoPage> {
      // 目录树里只有叶子节点有照片；其余目录返回空列表（模拟真实下钻）
      // 回收站里的、已经归档搬走的，都不在目录里出现
      const items =
        opts.dir === MOCK_ROOT
          ? records
              .filter((r) => !trashed.has(r.id))
              .map((rec) => {
                const photo = toPhoto(rec);
                photo.mark.stars = starsById.get(rec.id) ?? 0;
                return photo;
              })
          : [];
      const filtered = opts.filter === 'starred' ? items.filter((i) => i.mark.stars > 0) : items;
      return { items: filtered, total: filtered.length, nextCursor: null };
    },

    thumbUrl,

    async saveMarks(items: MarkInput[]): Promise<MarkResult[]> {
      items.forEach((i) => {
        starsById.set(i.id, i.stars ?? 0);
        delById.set(i.id, Boolean(i.del));
      });
      return items.map((i) => ({ id: i.id, ok: true, error: null }));
    },

    async moveToTrash(ids: string[]): Promise<OpResult> {
      const now = new Date().toISOString();
      ids.forEach((id) => {
        const rec = byId.get(id);
        if (!rec) return;
        delById.delete(id);
        trashed.set(id, {
          photoId: id,
          displayName: rec.displayName,
          dir: `${TRASH_DIR}/${rec.id}`,
          fromDir: rec.dir,
          trashedAt: now,
          kind: 'photo',
          ar: rec.ar,
          stars: starsById.get(id) ?? 0,
          hasRaw: rec.hasRaw,
          hasJpeg: rec.hasJpeg,
          sizeBytes: rec.hasRaw ? 52_000_000 : 9_000_000,
        });
      });
      return { ok: ids.length, failed: [] };
    },

    async restore(ids: string[]): Promise<OpResult> {
      ids.forEach((id) => trashed.delete(id));
      return { ok: ids.length, failed: [] };
    },

    async listTrash(): Promise<TrashEntry[]> {
      return [...trashed.values()].sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
    },

    async emptyTrash(ids?: string[]): Promise<OpResult> {
      if (!ids?.length) {
        const n = trashed.size;
        trashed.clear();
        return { ok: n, failed: [] };
      }
      let n = 0;
      ids.forEach((id) => {
        if (trashed.delete(id)) n++;
      });
      return { ok: n, failed: [] };
    },
  };
}
