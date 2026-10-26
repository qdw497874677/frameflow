import type {
  AnnotateSource,
  JobCreateInput,
  JobSource,
  ListPhotosOptions,
  PhotoPage,
  PhotoSource,
} from './source';
import type { FsBrowseDto } from './contract';
import { matchesSelection } from '../core/selection';
import { itemsProgress } from '../core/progress';
import { PALETTES, mulberry, renderMockPhoto, type FocusKind, type MockSpec } from './mock/render';
import type {
  Channel,
  FolderListing,
  InboundItem,
  Job,
  JobEvent,
  JobItem,
  MarkChange,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  Selection,
  TrashEntry,
} from '../core/types';

/**
 * Mock 数据源：浏览器内假照片 + 假目录树 + 假回收站。
 * 目的是让整套交互（尤其手势/物理、变焦、回收站）能在没有后端的情况下开发到位；
 * 一旦后端可用，把 api/index.ts 切到 httpSource 即可，UI 不改。
 */

const CAMS = ['Sony A7M4 · 24-70', 'Fuji X-T5 · 35 1.4', 'Ricoh GR3', 'iPhone 15 Pro'];
const COUNT = 60;

/** mock 的范围 token：`mock-<jobId>`（真后端是 HMAC 签的 `annotate|…`） */
function jobIdOfMockToken(token: string): string {
  return token.startsWith('mock-') ? token.slice(5) : '';
}

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

export function createMockSource(): PhotoSource & JobSource & AnnotateSource {
  const records = buildRecords(MOCK_ROOT);
  const byId = new Map(records.map((r) => [r.id, r]));
  const cache = new Map<string, string>();
  /** 进了回收站的 id（列表里就看不见了） */
  const trashed = new Map<string, TrashEntry>();
  const starsById = new Map<string, number>();
  const delById = new Map<string, boolean>();
  /** 变更日志：真后端会追加落盘（marks.jsonl），mock 存内存，读回来的形状一样 */
  const changeLog: MarkChange[] = [];

  // ── 任务（内存态）：形状与真后端一致 ──
  // mock 不做真派发、也不模拟外部回流（那是后端 /jobs/{id}/inbound 的事）；
  // 这里只把端口接通、形状摆对，让任务页能在没后端时开发得下去。
  const jobs = new Map<string, Job>();
  const jobEventLog = new Map<string, JobEvent[]>();
  let jobCount = 0;
  let eventSeq = 0;

  const pushEvent = (jobId: string, ev: Omit<JobEvent, 'seq' | 'at'>): JobEvent => {
    const full: JobEvent = { ...ev, seq: ++eventSeq, at: new Date().toISOString() };
    const log = jobEventLog.get(jobId) ?? [];
    log.push(full);
    jobEventLog.set(jobId, log);
    return full;
  };

  /** mock 的选择集求值：复用前端谓词求值器（真后端在服务端算同一套语义） */
  const expandSelection = (sel: Selection): Photo[] =>
    records
      .filter((r) => !trashed.has(r.id))
      .map((rec) => {
        const photo = toPhoto(rec);
        photo.mark.stars = starsById.get(rec.id) ?? 0;
        photo.mark.del = delById.get(rec.id) ?? false;
        return photo;
      })
      .filter((p) => matchesSelection(p, sel))
      .slice(0, 40); // 演示用：最多 40 张，真后端不设这个上限

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

  // mock 的根全部可增删改名（内存态，刷新即丢；真后端写回配置）
  const rootsState: Root[] = [
    { id: 'photos', path: '/photos', diskPath: '/home/qa/Pictures/photos', label: '照片库', photoCount: records.length - trashed.size, online: true },
    { id: 'ssd', path: '/mnt/ssd', diskPath: '/mnt/ssd', label: '移动硬盘', photoCount: undefined, online: false },
  ];
  const rootsOf = (): Root[] => rootsState;

  // 内部互调用 api.*，不用 this —— 外部解构（const { planJob } = jobSource）也安全
  let api: PhotoSource & JobSource & AnnotateSource;

  // 批注页是整页加载（/j?t=…），mock 的内存态活不过导航 —— 预置一条演示任务，
  // 让 `/j?t=mock-demo` 冷启动也能打开（真后端不靠这个：链接里带范围 token 自己就是凭据）。
  {
    const now = new Date().toISOString();
    const demoItems: JobItem[] = records.slice(0, 12).map((rec) => ({
      id: rec.id,
      displayName: rec.displayName,
      status: 'planned',
    }));
    jobs.set('demo', {
      id: 'demo',
      kind: 'annotate',
      state: 'running',
      selection: { project: 'photos' },
      params: { channel: 'inapp', label: '外部批注人' },
      channel: 'inapp',
      dispatchedAt: now,
      progress: { done: 0, total: demoItems.length },
      items: demoItems,
      artifacts: [{ kind: 'url', path: '/j?t=mock-demo' }],
      error: null,
      reversible: true,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    });
    pushEvent('demo', { type: 'created', note: '（mock）演示任务：展开 12 张' });
    pushEvent('demo', { type: 'dispatched', channel: 'inapp', note: '（mock）演示链接 /j?t=mock-demo' });
  }

  return (api = {
    kind: 'mock',

    async listRoots() {
      return rootsOf();
    },

    async addRoot(input: { path: string; label?: string }) {
      const path = input.path.replace(/\/+$/, '');
      if (rootsOf().some((r) => r.path === path)) throw new Error(`这个目录已经是项目了：${path}`);
      const id = path.split('/').pop() || 'root';
      const root: Root = { id, path, diskPath: path, label: input.label?.trim() || id, photoCount: 0, online: true };
      rootsState.push(root);
      return root;
    },

    async renameRoot(id: string, label: string) {
      const root = rootsState.find((r) => r.id === id);
      if (!root) throw new Error(`没有这个根：${id}`);
      if (!label.trim()) throw new Error('显示名不能为空');
      root.label = label.trim();
      return root;
    },

    async removeRoot(id: string) {
      const i = rootsState.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`没有这个根：${id}`);
      rootsState.splice(i, 1);
    },

    async browseFs(path?: string): Promise<FsBrowseDto> {
      // mock：一小棵假目录树，够「选择目录」演示下钻/上翻
      const FS: Record<string, string[]> = {
        '/home/qa': ['Pictures', 'Projects', 'Downloads'],
        '/home/qa/Pictures': ['2024', '2025'],
        '/home/qa/Pictures/2024': ['0301-公园', '0712-海边'],
        '/home/qa/Pictures/2025': ['0101-跨年'],
        '/mnt': ['ssd'],
      };
      const cur = path ?? '/home/qa';
      if (!(cur in FS)) throw new Error(`读不了这个目录：${cur}`);
      const parent = cur === '/' ? null : cur.slice(0, cur.lastIndexOf('/')) || '/';
      return {
        path: cur,
        parent,
        dirs: FS[cur].map((name) => ({ name, path: `${cur === '/' ? '' : cur}/${name}` })).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      };
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
      // recursive = 含子目录：mock 的照片全在 MOCK_ROOT 这一层，所以任何目录下递归看都是它们
      // 回收站里的不在目录里出现；选择集（谓词）在这里求值（真后端在服务端求）
      const items =
        opts.dir === MOCK_ROOT || opts.recursive === true
          ? records
              .filter((r) => !trashed.has(r.id))
              .map((rec) => {
                const photo = toPhoto(rec);
                photo.mark.stars = starsById.get(rec.id) ?? 0;
                photo.mark.del = delById.get(rec.id) ?? false;
                return photo;
              })
              .filter((p) => matchesSelection(p, opts.selection))
          : [];
      return { items, total: items.length, nextCursor: null };
    },

    thumbUrl,

    async saveMarks(items: MarkInput[]): Promise<MarkResult[]> {
      const now = new Date().toISOString();
      items.forEach((i) => {
        const prev: { stars: number; del: boolean } = {
          stars: starsById.get(i.id) ?? 0,
          del: delById.get(i.id) ?? false,
        };
        const next = { stars: i.stars ?? prev.stars, del: Boolean(i.del ?? prev.del) };
        if (next.stars > 0 && next.del) next.del = false; // 不变式：互斥（后端同样会在写前纠正）

        const at = i.at ?? now;
        const by = i.by ?? 'me';
        const channel = i.channel ?? 'inapp';
        const rec = byId.get(i.id);
        (['stars', 'del'] as const).forEach((field) => {
          if (prev[field] === next[field]) return;
          changeLog.push({
            photoId: i.id,
            displayName: rec?.displayName,
            field,
            from: prev[field],
            to: next[field],
            by,
            channel,
            at,
          });
        });

        starsById.set(i.id, next.stars);
        delById.set(i.id, next.del);
      });
      return items.map((i) => ({ id: i.id, ok: true, error: null }));
    },

    /** 变更日志（最新的在前）。真后端读 marks.jsonl；形状与排序与这里一致 */
    async listMarkHistory(opts): Promise<MarkChange[]> {
      const all = opts?.photoId ? changeLog.filter((c) => c.photoId === opts.photoId) : changeLog;
      const newest = [...all].reverse();
      return opts?.limit ? newest.slice(0, opts.limit) : newest;
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

    // ── 任务（动作层）──────────────────────────────────────────────

    async createJob(input: JobCreateInput): Promise<Job> {
      const mode = input.mode ?? 'plan';
      const now = new Date().toISOString();
      const items: JobItem[] = expandSelection(input.selection).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        status: 'planned',
      }));
      const channel = typeof input.params?.channel === 'string' ? input.params.channel : null;
      const id = `${mode === 'plan' ? 'plan' : 'job'}-${++jobCount}`;
      const job: Job = {
        id,
        kind: input.kind,
        state: mode === 'plan' ? 'planned' : 'running',
        selection: input.selection,
        params: input.params ?? {},
        channel,
        dispatchedAt: mode === 'apply' ? now : null,
        progress: itemsProgress(items),
        items,
        // annotate 的产物就是那张「打开就能批注」的卡片链接（真后端签范围 token）
        artifacts: mode === 'apply' ? [{ kind: 'url', path: `/j?t=mock-${id}` }] : [],
        error: null,
        reversible: input.kind === 'annotate',
        createdAt: now,
        startedAt: mode === 'apply' ? now : null,
        finishedAt: null,
      };
      if (mode === 'plan') return job; // 预演不落库
      jobs.set(id, job);
      pushEvent(id, { type: 'created', note: `展开 ${items.length} 张` });
      pushEvent(id, { type: 'dispatched', channel, note: '（mock）已派发，等回流' });
      return job;
    },

    async planJob(input: JobCreateInput): Promise<Job> {
      return api.createJob({ ...input, mode: 'plan' });
    },

    async listJobs(opts) {
      const all = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const byState = opts?.state ? all.filter((j) => j.state === opts.state) : all;
      return typeof opts?.limit === 'number' ? byState.slice(0, opts.limit) : byState;
    },

    async getJob(id: string): Promise<Job> {
      const job = jobs.get(id);
      if (!job) throw new Error(`没有这个任务：${id}`);
      return job;
    },

    async jobEvents(id: string, opts?: { since?: number; limit?: number }) {
      if (!jobs.has(id)) throw new Error(`没有这个任务：${id}`);
      const since = opts?.since ?? 0;
      const after = (jobEventLog.get(id) ?? []).filter((e) => e.seq > since);
      const items = typeof opts?.limit === 'number' ? after.slice(0, opts.limit) : after;
      return { items, nextSince: items.at(-1)?.seq ?? since };
    },

    async cancelJob(id: string): Promise<Job> {
      const job = await api.getJob(id);
      if (job.state === 'done' || job.state === 'cancelled') return job;
      job.state = 'cancelled';
      job.finishedAt = new Date().toISOString();
      pushEvent(id, { type: 'cancelled', note: '取消（mock 不回滚已写入的标注）' });
      return job;
    },

    // 滤镜阶段：mock 没有风格文件（预览即原图），只演示状态流转
    async jobAction(id: string, name: string, body: Record<string, unknown> = {}): Promise<Job> {
      const job = await api.getJob(id);
      if (name === 'set') {
        const item = job.items.find((i) => i.id === body.photoId);
        if (!item) throw new Error('这张照片不在这个任务里');
        const prev = body.reset === true ? {} : { ...(item.grade ?? {}) };
        if (body.look !== undefined) prev.look = body.look as string | null;
        if (typeof body.strength === 'number') prev.strength = body.strength;
        // 与服务端一致：只有显式 reviewed 改过目
        if (body.reviewed === true) prev.reviewedAt = new Date().toISOString();
        else if (body.reviewed === false) prev.reviewedAt = null;
        item.grade = prev;
      } else if (name === 'defaults') {
        job.params = { ...job.params, ...body };
      } else if (name === 'complete') {
        job.items.forEach((i) => { if (i.status === 'planned') i.status = 'done'; });
        job.progress = itemsProgress(job.items);
        job.state = 'done';
        job.finishedAt = new Date().toISOString();
        job.artifacts = [{ kind: 'dir', path: `exports/${id}` }];
        pushEvent(id, { type: 'done', note: '（mock）导出完成' });
      } else throw new Error(`没有操作 ${name}`);
      return { ...job, items: job.items.map((i) => ({ ...i })) };
    },

    async listLooks() {
      return [];
    },

    async lookCube(id: string): Promise<string> {
      throw new Error(`mock 没有风格文件：${id}`);
    },

    async undoJob(id: string): Promise<Job> {
      const job = await api.getJob(id);
      if (!job.reversible) throw new Error('这个任务不可撤销');
      job.state = 'cancelled';
      job.finishedAt = new Date().toISOString();
      pushEvent(id, { type: 'undone', note: '（mock）已撤销' });
      return job;
    },

    async listChannels(): Promise<Channel[]> {
      return [
        { id: 'inapp', kind: 'inapp', label: '应用内', enabled: true },
        { id: 'feishu', kind: 'feishu', label: '飞书（未配置）', enabled: false },
      ];
    },

    // ── 批注页（/j?t=）───────────────────────────────────────────
    // mock 的范围 token 就写成 `mock-<jobId>`：离线开发/截图时能直接打开批注页。
    // 语义对齐真后端：by 由链接里的批注人推（外部批注人）、clientRef 幂等、回流推进 items 与进度。

    async getJobForAnnotator(token: string, jobId: string): Promise<Job> {
      return api.getJob(jobIdOfMockToken(token) || jobId);
    },

    thumbUrlForAnnotator(photoId: string, _token: string, size: 512 | 2048): string {
      return thumbUrl(photoId, size);
    },

    async submitInbound(token: string, jobId: string, inbound: InboundItem[]): Promise<MarkResult[]> {
      const id = jobIdOfMockToken(token) || jobId;
      const job = await api.getJob(id);
      const now = new Date().toISOString();
      const by = 'link:外部批注人';
      const results: MarkResult[] = [];
      for (const entry of inbound) {
        const item = job.items.find((i) => i.id === entry.photoId);
        if (!item) {
          results.push({ id: entry.photoId, ok: false, error: '这张不在任务里' });
          continue;
        }
        // 幂等：同一个 clientRef 再来一次 = 跳过（与真后端一致：返回首次结果）
        if (entry.clientRef && item.clientRef === entry.clientRef && item.status !== 'planned') {
          pushEvent(id, { type: 'skipped', photoId: entry.photoId, clientRef: entry.clientRef, note: '（mock）重复提交，跳过' });
          results.push({ id: entry.photoId, ok: true, error: null });
          continue;
        }
        const prev = { stars: starsById.get(entry.photoId) ?? 0, del: delById.get(entry.photoId) ?? false };
        const next = { stars: entry.stars ?? prev.stars, del: Boolean(entry.del ?? prev.del) };
        if (next.stars > 0 && next.del) next.del = false;
        (['stars', 'del'] as const).forEach((field) => {
          if (prev[field] === next[field]) return;
          changeLog.push({
            photoId: entry.photoId,
            displayName: byId.get(entry.photoId)?.displayName,
            field,
            from: prev[field],
            to: next[field],
            by,
            channel: job.channel ?? 'inapp',
            at: entry.at ?? now,
          });
        });
        starsById.set(entry.photoId, next.stars);
        delById.set(entry.photoId, next.del);
        item.stars = next.stars;
        item.del = next.del;
        item.status = 'done';
        item.clientRef = entry.clientRef ?? null;
        item.at = entry.at ?? now;
        job.progress = itemsProgress(job.items);
        pushEvent(id, {
          type: 'applied',
          photoId: entry.photoId,
          to: next.stars > 0 ? `★${next.stars}` : next.del ? '待删' : '取消标记',
          by,
          clientRef: entry.clientRef,
        });
        results.push({ id: entry.photoId, ok: true, error: null });
      }
      if (job.progress.done === job.progress.total && job.items.length > 0) {
        job.state = 'done';
        job.finishedAt = now;
        pushEvent(id, { type: 'done', note: '（mock）items 全有终态' });
      }
      return results;
    },

    // mock 没有认证：开发时不必登录
    async authStatus() {
      return { required: false, authed: true };
    },
    async login() {},
    async logout() {},
  });
}
