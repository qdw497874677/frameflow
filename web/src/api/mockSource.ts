import type { ListPhotosOptions, PhotoPage, PhotoSource, PlanOptions } from './source';
import { PALETTES, mulberry, renderMockPhoto, type FocusKind, type MockSpec } from './mock/render';
import type {
  ArchiveMove,
  ArchivePlan,
  ArchiveResult,
  FolderListing,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  Rule,
  TrashEntry,
} from '../core/types';

/**
 * Mock 数据源：浏览器内假照片 + 假目录树 + 假回收站/规则/归档。
 * 目的是让整套交互（尤其手势/物理、变焦、归档预演）能在没有后端的情况下开发到位；
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

/** 设备名从「Sony A7M4 · 24-70」里取出机器那半截 */
function deviceOf(camera: string | null | undefined): string {
  return (camera ?? '未知设备').split('·')[0]!.trim();
}

/** 项目名 = 根目录之后的第一段路径（/photos/2026-冰岛/A7M4/… → 2026-冰岛） */
function projectOf(dir: string): string {
  const rest = dir.split('/').filter(Boolean);
  return rest[1] ?? '未分项目';
}

/** 模板变量展开：{root} {project} {device} {kind} {variant} {date} */
function expandTemplate(tpl: string, rec: MockRecord & { stars: number }, root: string): string {
  const date = (rec.mtime ?? '').slice(0, 10);
  const vars: Record<string, string> = {
    root,
    project: projectOf(rec.dir),
    device: deviceOf(rec.camera),
    kind: rec.kind === 'video' ? '视频' : '照片',
    variant: rec.stars >= 3 ? '修改后' : '原始',
    date,
  };
  return tpl.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

const DEMO_RULES: Rule[] = [
  {
    id: 'rule-starred',
    name: '喜欢的（≥3 星）→ 修改后',
    enabled: true,
    match: { kind: 'any', minStars: 3, del: false, camera: null },
    dest: '{root}/{project}/{device}/照片/修改后',
    onConflict: 'rename',
    pair: true,
  },
  {
    id: 'rule-raw',
    name: '其余原图 → 原始',
    enabled: true,
    match: { kind: 'photo', minStars: 0, del: false, camera: null },
    dest: '{root}/{project}/{device}/照片/原始',
    onConflict: 'rename',
    pair: true,
  },
  {
    id: 'rule-video',
    name: '视频 → 视频目录',
    enabled: false,
    match: { kind: 'video', minStars: 0, del: false, camera: null },
    dest: '{root}/{project}/{device}/视频',
    onConflict: 'rename',
    pair: false,
  },
];

function matches(rule: Rule, rec: MockRecord & { stars: number; del: boolean }): boolean {
  const m = rule.match;
  if (!rule.enabled) return false;
  if (m.kind && m.kind !== 'any' && m.kind !== rec.kind) return false;
  if ((m.minStars ?? 0) > 0 && rec.stars < (m.minStars ?? 0)) return false;
  // 待删的照片不进归档（它们该进回收站）；规则要专门归档待删时才反过来
  if (m.del ? !rec.del : rec.del) return false;
  if (m.camera && m.camera !== rec.camera) return false;
  return true;
}

export function createMockSource(): PhotoSource {
  const records = buildRecords(MOCK_ROOT);
  const byId = new Map(records.map((r) => [r.id, r]));
  const cache = new Map<string, string>();
  /** 进了回收站的 id（列表里就看不见了） */
  const trashed = new Map<string, TrashEntry>();
  /** 已经归档搬走的 id */
  const movedAway = new Map<string, string>();
  const rules: Rule[] = DEMO_RULES.map((r) => ({ ...r, match: { ...r.match } }));
  const starsById = new Map<string, number>();
  const delById = new Map<string, boolean>();
  const plans = new Map<string, ArchivePlan>();

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
        photoCount: path === MOCK_ROOT ? records.length - trashed.size - movedAway.size : 0,
      };
    },

    async listPhotos(opts: ListPhotosOptions): Promise<PhotoPage> {
      // 目录树里只有叶子节点有照片；其余目录返回空列表（模拟真实下钻）
      // 回收站里的、已经归档搬走的，都不在目录里出现
      const items =
        opts.dir === MOCK_ROOT
          ? records
              .filter((r) => !trashed.has(r.id) && !movedAway.has(r.id))
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

    async listRules(): Promise<Rule[]> {
      return rules.map((r) => ({ ...r, match: { ...r.match } }));
    },

    async saveRules(next: Rule[]): Promise<Rule[]> {
      rules.length = 0;
      rules.push(...next.map((r) => ({ ...r, match: { ...r.match } })));
      return rules.map((r) => ({ ...r, match: { ...r.match } }));
    },

    async planArchive(opts: PlanOptions): Promise<ArchivePlan> {
      const only = opts.ruleIds?.length ? new Set(opts.ruleIds) : null;
      const active = rules.filter((r) => r.enabled && (!only || only.has(r.id)));
      const moves: ArchiveMove[] = [];
      const skipped: ArchivePlan['skipped'] = [];
      let totalBytes = 0;

      for (const rec of records) {
        if (trashed.has(rec.id) || movedAway.has(rec.id) || rec.dir !== opts.dir) continue;
        const stars = starsById.get(rec.id) ?? 0;
        const del = delById.get(rec.id) ?? false;
        if (opts.onlyStarred && stars === 0) continue;
        if (del) {
          skipped.push({ photoId: rec.id, displayName: rec.displayName, reason: '待删：先移入回收站' });
          continue;
        }
        const withStars = { ...rec, stars, del };
        const rule = active.find((r) => matches(r, withStars));
        if (!rule) {
          skipped.push({ photoId: rec.id, displayName: rec.displayName, reason: '没有匹配的规则' });
          continue;
        }
        const to = `${expandTemplate(rule.dest, withStars, '/photos')}/${rec.displayName}`;
        if (to === `${rec.dir}/${rec.displayName}`) {
          skipped.push({ photoId: rec.id, displayName: rec.displayName, reason: '已经在目标目录' });
          continue;
        }
        const size = rec.hasRaw ? 52_000_000 : 9_000_000;
        totalBytes += size;
        moves.push({
          photoId: rec.id,
          displayName: rec.displayName,
          from: rec.dir,
          to,
          kind: 'photo' as const,
          stars,
          sizeBytes: size,
          ruleId: rule.id,
          ruleName: rule.name,
        });
      }

      const plan: ArchivePlan = {
        id: `plan-${Date.now()}`,
        dir: opts.dir,
        createdAt: new Date().toISOString(),
        moves,
        skipped,
        totalBytes,
      };
      plans.set(plan.id, plan);
      return plan;
    },

    async applyArchive(planId: string): Promise<ArchiveResult> {
      const plan = plans.get(planId);
      if (!plan) return { planId, moved: 0, failed: [{ id: planId, error: '预演不存在或已过期' }] };
      plan.moves.forEach((m) => movedAway.set(m.photoId, m.to));
      return { planId, moved: plan.moves.length, failed: [] };
    },
  };
}
