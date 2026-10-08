/**
 * 库：把「磁盘上有什么」变成「能查的集合」。
 *
 * 三件事：
 *  1. 跑扫描（scan.ts）并把不可重建/可重建的东西管起来；
 *  2. 内存索引：目录树（每层直接照片数 + 递归数）、照片按 id/目录取；
 *  3. 标注：接 marks.jsonl 与照片旁的 XMP（marks.ts）。
 *
 * 索引本身是**可重建**的，落 `dataDir/index.json` 的唯一目的是省掉冷启动时的 exiftool 全量重读：
 * 里面存的是按 `path+mtime+size` 判脏的元数据缓存，坏了/删了只是下次扫慢一点。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';import { expandHome, persistRoots, type Config } from '../config.ts';
import { CacheJanitor, type CacheEvictResult, type CacheStats } from './cache.ts';
import { extOf, IMAGE_EXTS, RAW_EXTS } from './exts.ts';
import type { FileRef } from './photo.ts';
import {
  toPhotoDto,
  toTrashEntryDto,
  type FolderDto,
  type FolderListingDto,
  type OpFailureDto,
  type OpResultDto,
  type PhotoDto,
  type RootDto,
  type TrashEntryDto,
} from './dto.ts';
import { dirPath, parseDirPath } from './ids.ts';
import { MarksStore, type MarkChange, type MarkInput, type MarkResultDto } from './marks.ts';
import type { PhotoRecord } from './photo.ts';
import { matchesSelection, selectionIsEmpty, type Selection } from './selection.ts';
import { scanLibrary, type CachedMeta } from './scan.ts';
import { Thumbs } from './thumbs.ts';
import { moveFile, removeTrashDir, TrashStore, TRASH_DIR, uniqueDirName, uniqueFilePath, type TrashFileMove, type TrashRecord } from './trash.ts';

export interface ListPhotosArgs {
  dir: string;
  selection?: Selection;
  cursor?: string | null;
  limit?: number;
}

export interface PhotoPageDto {
  items: PhotoDto[];
  nextCursor: string | null;
  total: number;
}

export interface LibraryStatus {
  scanning: boolean;
  lastScanAt: string | null;
  photos: number;
  videos: number;
  starred: number;
  /** 回收站里现在有多少张（已经搬走的） */
  trashed: number;
  /** 还留在原地、只标了「待删」的 */
  markedDel: number;
  files: number;
  errors: string[];
  /** 预览缓存的占用与上一轮淘汰（票 013） */
  cache: CacheStats;
  /** 启动自动补扫的状态（票 013）：索引比 `afterDays` 旧就补扫一次，0 = 关 */
  autoRescan: { afterDays: number; lastScanAt: string | null; triggeredAt: string | null };
}

interface DirStat {
  /** 本目录直接含有的照片对数 */
  direct: number;
  /** 含子目录在内的照片对数 */
  recursive: number;
  children: Set<string>;
}

/**
 * 索引文件版本。
 * 1 → 只存 `metaCache`（EXIF 缓存），照片列表靠每次启动重扫；
 * 2 → 连 `records` 一起存，冷启动可以**不碰文件系统**先把列表端出来（随后后台扫描校正）。
 */
const INDEX_VERSION = 2;

/** 扫描超时过的根，多久之内不再去碰（熔断）。手动「重扫」会立即重试。 */
const HUNG_COOLDOWN_MS = 10 * 60_000;

/** `index.json` 的形状。缓存坏了、版本不认，就当没有 —— 扫描能重建一切。 */
interface IndexFile {
  version?: number;
  savedAt?: string;
  lastScanAt?: string | null;
  fileCount?: number;
  online?: Record<string, boolean>;
  /** 每个根上次判离线的原因（给 `/roots` 的 `lastError`） */
  rootErrors?: Record<string, string>;
  records?: PhotoRecord[];
  metaCache?: Record<string, CachedMeta>;
}

/** 反序列化的最小校验：缺胳膊少腿的记录宁可丢掉，不能让它带坏整棵目录树。 */
function isPhotoRecord(v: unknown): v is PhotoRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<PhotoRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.rootId === 'string' &&
    typeof r.relDir === 'string' &&
    typeof r.previewPath === 'string' &&
    (r.kind === 'photo' || r.kind === 'video')
  );
}

export class Library {
  readonly thumbs: Thumbs;
  readonly marks: MarksStore;
  readonly trash: TrashStore;
  /** 预览缓存的容量策略（票 013）：上限 + 按 atime 的 LRU 淘汰 */
  readonly cache: CacheJanitor;

  private readonly cfg: Config;
  private records = new Map<string, PhotoRecord>();
  /** 已经搬进回收站的照片：从 `records` 里拿走了，但缩略图/预览还得找得到文件 */
  private trashedById = new Map<string, PhotoRecord>();
  private byDir = new Map<string, PhotoRecord[]>();
  private dirs = new Map<string, DirStat>();
  private metaCache = new Map<string, CachedMeta>();
  private online = new Map<string, boolean>();
  /** 每个根上一次判离线的原因（`/roots` 的 `lastError`） */
  private rootErrors = new Map<string, string>();
  /** 扫描超时过的根 → 冷却到什么时候（票 011 的熔断：挂死的挂载不反复去碰） */
  private hungUntil = new Map<string, number>();
  scanning = false;
  /** 扫描进行中又被要求扫一次 → 记下来，扫完立刻补一遍（外部工具改盘常常赶在扫描中途） */
  private rescanQueued = false;
  private lastScanAt: string | null = null;
  private lastErrors: string[] = [];
  private fileCount = 0;
  /** 冷启动从 index.json 恢复到的内容（非 null = 启动日志里说一句「先吃缓存，后台补扫」） */
  private restored: { photos: number; savedAt: string | null } | null = null;
  /** 上一次自动补扫是什么时候（票 013，给 `/capabilities` 看） */
  private autoRescanAt: string | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    mkdirSync(cfg.dataDir, { recursive: true });
    this.thumbs = new Thumbs(cfg.dataDir);
    this.marks = new MarksStore(cfg.dataDir);
    this.trash = new TrashStore(cfg.dataDir);
    this.cache = new CacheJanitor({
      dirs: this.thumbs.cacheDirs(),
      maxBytes: cfg.cache.maxBytes,
      // 正在生成的缩略图/封面不能被删：删了会写出半截文件（票 013 验收）
      isProtected: (path) => this.thumbs.protectedPaths().has(path),
    });
    this.loadIndex();
  }

  // ── 扫描 ────────────────────────────────────────────────────────────────

  async refresh(): Promise<{ photos: number; files: number; ms: number; errors: string[] }> {
    if (this.scanning) {
      this.rescanQueued = true;
      return { photos: this.records.size, files: this.fileCount, ms: 0, errors: ['已有扫描在进行中'] };
    }
    this.scanning = true;
    const t0 = Date.now();
    try {
      // 熔断：刚超时过的根在冷却期内不再去碰 —— 挂死的挂载上每次重试都要等一个超时，
      // 还会占住一个 libuv 线程。手动「重扫」可强制重试（见 requestRefresh）。
      const prevErrors = this.rootErrors;
      const now = Date.now();
      const skipped = this.cfg.roots.filter((r) => (this.hungUntil.get(r.id) ?? 0) > now);
      const roots = this.cfg.roots.filter((r) => !skipped.includes(r));
      const res = await scanLibrary({
        roots,
        ignore: this.cfg.scan.ignore,
        maxDepth: this.cfg.scan.maxDepth,
        metaCache: this.metaCache,
        rootTimeoutMs: this.cfg.scan.rootTimeoutMs,
        hasExtractedPreview: ({ absStem, sig }) => existsSync(this.thumbs.previewCachePath(absStem, sig)),
        onError: (text) => {
          if (!this.lastErrors.includes(text)) this.lastErrors.push(text);
        },
      });
      this.metaCache = res.metaCache;
      this.online = res.online;
      this.rootErrors = new Map();
      for (const [id, st] of res.rootStates) {
        if (st.error) this.rootErrors.set(id, st.error);
        if (st.timedOut) this.hungUntil.set(id, Date.now() + HUNG_COOLDOWN_MS);
        else if (st.online) this.hungUntil.delete(id);
      }
      for (const r of skipped) {
        const reason = prevErrors.get(r.id) ?? '上次扫描超时：冷却中，点「重扫」可立即重试';
        this.online.set(r.id, false);
        this.rootErrors.set(r.id, reason);
        res.errors.push(`跳过 ${r.id}：${reason}`);
      }
      this.lastErrors = res.errors.slice(0, 50);
      this.fileCount = res.fileCount;
      this.records = new Map(res.records.map((r) => [r.id, r]));
      this.reindex();
      // 照片旁的 XMP 作为基线（日志里已有更晚记录的不会被覆盖）
      for (const rec of res.records) {
        if (rec.stars > 0 || rec.del) this.marks.seedFromXmp(rec.id, { stars: rec.stars, del: rec.del });
      }
      this.lastScanAt = new Date().toISOString();
      this.saveIndex();
      this.rebuildTrashed();
      return { photos: this.records.size, files: this.fileCount, ms: Date.now() - t0, errors: this.lastErrors };
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.refresh().catch(() => undefined);
      }
    }
  }

  /**
   * 「现在扫一遍，扫不了就排队补扫一次」。
   * 扫描进行中时新落的文件这一遍看不见 —— 排队补扫就不需要人再点一次。
   */
  requestRefresh(opts: { force?: boolean } = {}): { started: boolean; queued: boolean } {
    if (this.scanning) {
      // 排队的那次不继承 force：冷却期还是要守，不然连点两下就把失联的挂载又拖一遍
      this.rescanQueued = true;
      return { started: false, queued: true };
    }
    if (opts.force) this.hungUntil.clear(); // 手动重扫 = 对失联的挂载也立刻重试一次
    void this.refresh().catch(() => undefined);
    return { started: true, queued: false };
  }

  /**
   * 启动时探一下每个根的挂载在不在（`/roots` 的 online）。全异步 + 超时：
   * 挂死的网络挂载上 `stat` 会永不返回，同步探一次就把事件循环堵死了（票 011）。
   */
  async probeRoots(timeoutMs = 3000): Promise<void> {
    await Promise.all(
      this.cfg.roots.map(async (r) => {
        if (this.online.has(r.id)) return;
        const ok = await Promise.race([
          stat(resolvePath(r.path)).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((done) => {
            setTimeout(() => done(false), timeoutMs).unref();
          }),
        ]);
        this.online.set(r.id, ok);
        if (!ok) this.rootErrors.set(r.id, '项目暂时访问不到：挂载没挂上或已断开');
      }),
    );
  }

  /**
   * 运行时添加项目（设置页「添加项目」）：探路径可达 → 入列 → 写回配置 → 后台扫描。
   * 探测沿用 probeRoots 的思路（超时闸）：挂死的网络挂载上 `stat` 永不返回，不能把请求也挂死。
   */
  async addRoot(input: { path: string; label?: string }): Promise<RootDto> {
    const path = resolvePath(expandHome(String(input.path ?? '').trim()));
    if (!input.path?.trim() || !path.startsWith('/')) throw new Error('要给一个绝对路径（以 / 开头）');
    if (this.cfg.roots.some((r) => resolvePath(r.path) === path)) throw new Error(`这个目录已经是项目了：${path}`);
    const reachable = await Promise.race([
      stat(path).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((done) => {
        setTimeout(() => done(false), 3000).unref();
      }),
    ]);
    if (!reachable) throw new Error(`路径访问不到（不存在，或挂载无响应）：${path}`);
    const label = (input.label ?? '').trim() || basename(path);
    // id 从 label 派生，撞了就加 -2/-3 —— 与 loadConfig.normalizeRoots 同一套规则
    const baseId =
      label
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'root';
    let id = baseId;
    let n = 2;
    while (this.cfg.roots.some((r) => r.id === id)) id = `${baseId}-${n++}`;
    this.cfg.roots.push({ id, label, path });
    persistRoots(this.cfg);
    this.online.set(id, true);
    this.rootErrors.delete(id);
    // 新根的照片数还是 0：立即后台补扫，侧边栏树/计数随后到位（refresh 自己有并发闸）
    void this.refresh().catch(() => undefined);
    return this.roots().find((r) => r.id === id)!;
  }

  /** 改显示名：只动配置里的 label，id/路径/照片都不动 */
  renameRoot(id: string, label: string): RootDto {
    const root = this.cfg.roots.find((r) => r.id === id);
    if (!root) throw new Error(`没有这个项目：${id}`);
    const clean = label.trim();
    if (!clean) throw new Error('显示名不能为空');
    root.label = clean;
    persistRoots(this.cfg);
    return this.roots().find((r) => r.id === id)!;
  }

  /**
   * 移除根：只解除映射 —— 配置里删掉、库里的照片/标记清掉，但盘上文件一个不动。
   * （全库唯一的 rmSync 在回收站真删里，这里不碰文件。）
   */
  removeRoot(id: string): void {
    const root = this.cfg.roots.find((r) => r.id === id);
    if (!root) throw new Error(`没有这个项目：${id}`);
    this.cfg.roots = this.cfg.roots.filter((r) => r.id !== id);
    persistRoots(this.cfg);
    this.online.delete(id);
    this.rootErrors.delete(id);
    this.hungUntil.delete(id);
    for (const key of [...this.records.keys()]) {
      if (this.records.get(key)?.rootId === id) this.records.delete(key);
    }
    this.reindex();
    this.rebuildTrashed();
    this.saveIndex();
  }

  get status(): LibraryStatus {
    let starred = 0;
    let markedDel = 0;
    let videos = 0;
    for (const rec of this.records.values()) {
      const stars = this.marks.starsOf(rec.id);
      if (stars > 0) starred++;
      if (this.marks.delOf(rec.id)) markedDel++;
      if (rec.kind === 'video') videos++;
    }
    return {
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
      photos: this.records.size,
      videos,
      starred,
      trashed: this.trash.list().length,
      markedDel,
      files: this.fileCount,
      errors: this.lastErrors.slice(0, 20),
      cache: this.cache.stats(),
      autoRescan: {
        afterDays: this.cfg.scan.autoRescanAfterDays,
        lastScanAt: this.lastScanAt,
        triggeredAt: this.autoRescanAt,
      },
    };
  }

  // ── 预览缓存（票 013）─────────────────────────────────────────────

  /**
   * 缓存维护：先量一遍（好让 `/capabilities` 马上有数字），再按上限淘汰。
   * 调用方在**起监听之后**调它 —— 大库启动时不能为了收拾缓存把端口堵住。
   */
  async maintainCache(): Promise<CacheEvictResult | null> {
    await this.cache.measure();
    let last: CacheEvictResult | null = null;
    // 单轮只啃得下 2000 个文件：超得很多时多跑几轮，每轮之间让出事件循环
    for (let round = 0; round < 10; round++) {
      const res = await this.cache.sweep();
      if (!res) return null; // 上限关着
      last = res;
      if (res.deleted === 0) break; // 没删动（都在途，或已经删够了）
      if (!res.truncated && res.bytes <= Math.floor(this.cfg.cache.maxBytes * 0.9)) break;
      await new Promise((r) => setImmediate(r));
    }
    return last;
  }

  /** 索引里的 `lastScanAt` 是不是比 `autoRescanAfterDays` 还旧（票 013） */
  autoRescanDue(): { due: boolean; lastScanAt: string | null; afterDays: number } {
    const afterDays = this.cfg.scan.autoRescanAfterDays;
    const lastScanAt = this.lastScanAt;
    if (afterDays <= 0 || !lastScanAt) return { due: false, lastScanAt, afterDays };
    const age = Date.now() - Date.parse(lastScanAt);
    return { due: Number.isFinite(age) && age > afterDays * 86_400_000, lastScanAt, afterDays };
  }

  /** 启动时记一笔：索引够旧 → 这次的启动扫描就是那次「补扫」（好让 `/capabilities` 看得见） */
  noteAutoRescanAtBoot(): boolean {
    if (!this.autoRescanDue().due) return false;
    this.autoRescanAt = new Date().toISOString();
    return true;
  }

  /**
   * 长期运行的实例：索引放旧了就补扫一次。部署在 NAS 上时进程可能几周不重启，
   * 新拍的照片不能等到下次重启才出现。
   */
  checkAutoRescan(): boolean {
    if (!this.autoRescanDue().due) return false;
    this.autoRescanAt = new Date().toISOString();
    this.requestRefresh();
    return true;
  }

  private reindex(): void {
    this.byDir.clear();
    this.dirs.clear();
    for (const rec of this.records.values()) {
      const dir = dirPath(rec.rootId, rec.relDir);
      const bucket = this.byDir.get(dir);
      if (bucket) bucket.push(rec);
      else this.byDir.set(dir, [rec]);

      // 目录统计：本层 + 每一层祖先（递归数），并且把**每一级父子边**都补上。
      // 只连「照片所在目录的上一级」是不够的 —— 那样 `/test` 到 `/test/项目/机身` 中间没有边，
      // 目录树从根往下走不动（前端侧边栏会显示成一个空壳子）。
      const stat = this.stat(dir);
      stat.direct++;
      const parts = dir.split('/').filter(Boolean); // [rootId, ...relDir]
      for (let i = parts.length; i >= 1; i--) {
        const ancestor = `/${parts.slice(0, i).join('/')}`;
        this.stat(ancestor).recursive++;
        if (i > 1) this.stat(`/${parts.slice(0, i - 1).join('/')}`).children.add(ancestor);
      }
    }
    for (const list of this.byDir.values()) list.sort(byName);
    // 根目录自身：即使一张照片都没有也要在树里可见
    for (const root of this.cfg.roots) this.stat(`/${root.id}`);
  }

  private stat(dir: string): DirStat {
    let s = this.dirs.get(dir);
    if (!s) {
      s = { direct: 0, recursive: 0, children: new Set() };
      this.dirs.set(dir, s);
    }
    return s;
  }

  // ── 目录与照片 ──────────────────────────────────────────────────────────

  /** `/roots`：每个配置的根一条；`path` 用虚拟路径（`/<id>`），真实磁盘路径在 `diskPath` */
  roots(): RootDto[] {
    return this.cfg.roots.map((r) => ({
      id: r.id,
      path: `/${r.id}`,
      label: r.label,
      diskPath: resolvePath(r.path),
      photoCount: this.dirs.get(`/${r.id}`)?.recursive ?? 0,
      // 没探过的根先当在线（乐观）；probeRoots()/refresh() 几毫秒内就会给出真实状态
      online: this.online.get(r.id) ?? true,
      lastError: this.rootErrors.get(r.id) ?? null,
    }));
  }

  /**
   * 把一个入参路径解析成 (rootId, relDir)。
   * 认两种写法：虚拟路径 `/<rootId>/子目录`，以及**真实磁盘路径**（人/CLI 更顺手）。
   */
  resolveDir(input?: string | null): { rootId: string; relDir: string } | null {
    if (!input) return null;
    const trimmed = input.replace(/\/+$/, '') || '/';
    const virtual = parseDirPath(trimmed);
    if (virtual && this.cfg.roots.some((r) => r.id === virtual.rootId)) return virtual;
    for (const r of this.cfg.roots) {
      const abs = resolvePath(r.path);
      if (trimmed === abs) return { rootId: r.id, relDir: '' };
      if (trimmed.startsWith(`${abs}/`)) return { rootId: r.id, relDir: trimmed.slice(abs.length + 1) };
    }
    return null;
  }

  listFolders(pathArg?: string | null): FolderListingDto | null {
    const at = pathArg ? this.resolveDir(pathArg) : null;
    if (pathArg && !at) return null;

    // 不带 path：返回一个合成根，列出所有配置的根（侧边栏「照片库 / 移动硬盘」那一层）
    if (!at) {
      return {
        path: '/',
        parent: null,
        folders: this.cfg.roots.map((r) => ({
          name: r.label,
          path: `/${r.id}`,
          photoCount: this.dirs.get(`/${r.id}`)?.recursive ?? 0,
          hasSubfolders: Boolean(this.dirs.get(`/${r.id}`)?.children.size),
        })),
        photoCount: 0,
      };
    }

    const dir = dirPath(at.rootId, at.relDir);
    const stat = this.dirs.get(dir);
    if (!stat) return null;
    const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
    const folders: FolderDto[] = [...stat.children]
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
      .map((child) => {
        const childStat = this.dirs.get(child);
        return {
          name: child.slice(child.lastIndexOf('/') + 1),
          path: child,
          photoCount: childStat?.recursive ?? 0,
          hasSubfolders: Boolean(childStat?.children.size),
        };
      });
    return { path: dir, parent, folders, photoCount: stat.direct };
  }

  listPhotos(args: ListPhotosArgs): PhotoPageDto | null {
    const at = this.resolveDir(args.dir);
    if (!at) return null;
    const dir = dirPath(at.rootId, at.relDir);
    const sel = args.selection;
    const wantDel = sel?.where?.del;
    const lastBy = (photoId: string): string | null => this.marks.lastBy(photoId);

    let list = (this.byDir.get(dir) ?? []).filter((rec) => {
      // 产品默认：待删的照片不进挑片视图（它们在回收站里）；显式写了 del:true 才要
      if (wantDel === true ? !this.marks.delOf(rec.id) : this.marks.delOf(rec.id)) return false;
      if (!sel || selectionIsEmpty(sel)) return true;
      return matchesSelection(rec, sel, lastBy);
    });

    const limit = Math.max(1, Math.min(1000, args.limit ?? 200));
    let start = 0;
    if (args.cursor) {
      const decoded = decodeCursor(args.cursor);
      if (decoded) {
        const idx = list.findIndex((r) => r.id === decoded);
        if (idx >= 0) start = idx + 1;
      }
    }
    const page = list.slice(start, start + limit);
    const nextStart = start + page.length;
    const items = page.map((rec) => {
      const dto = toPhotoDto(rec);
      dto.stars = this.marks.starsOf(rec.id);
      dto.del = this.marks.delOf(rec.id);
      return dto;
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: nextStart < list.length && last ? encodeCursor(last.id) : null,
      total: list.length,
    };
  }

  get(id: string): PhotoRecord | undefined {
    return this.records.get(id) ?? this.trashedById.get(id);
  }

  /**
   * 全局求值一个选择集（不按目录切页）—— 任务层把选择集展开成 items 快照就用它。
   * 逐张规则与 listPhotos 一致（含「未显式 `where.del:true` 时待删照片不出现」），
   * `selection.project` 只决定范围、不参与逐张求值。挑片视图请继续用 listPhotos（它管分页与目录）。
   */
  select(sel: Selection): PhotoRecord[] {
    const wantDel = sel.where?.del;
    const lastBy = (photoId: string): string | null => this.marks.lastBy(photoId);
    const out: PhotoRecord[] = [];
    for (const rec of this.records.values()) {
      if (wantDel === true ? !this.marks.delOf(rec.id) : this.marks.delOf(rec.id)) continue;
      if (!selectionIsEmpty(sel) && !matchesSelection(rec, sel, lastBy)) continue;
      out.push(rec);
    }
    return out.sort(byName);
  }

  /** 把 id 解成磁盘上的绝对路径（`variant` 决定要 RAW 还是 JPEG） */
  absFile(rec: PhotoRecord, variant: 'jpeg' | 'raw' | 'video' | 'auto'): { path: string; name: string; mime: string } | null {
    const pick = variant === 'raw' ? rec.raw : variant === 'jpeg' ? rec.jpeg : variant === 'video' ? rec.video : (rec.jpeg ?? rec.raw ?? rec.video);
    if (!pick) return null;
    const name = `${rec.displayName}${pick.ext}`;
    const ext = pick.ext.toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : ext === '.mp4' || ext === '.m4v' ? 'video/mp4'
      : ext === '.mov' ? 'video/quicktime'
      : 'application/octet-stream';
    return { path: pick.path, name, mime };
  }

  /** 照片旁 XMP 的落点：`_DSC1042.xmp`（Adobe 规范的 stem 式命名） */
  sidecarPath(rec: PhotoRecord): string | null {
    const src = rec.raw ?? rec.jpeg;
    if (!src) return null;
    return `${src.path.slice(0, src.path.length - src.ext.length)}.xmp`;
  }

  // ── 回收站 ──────────────────────────────────────────────────────────────

  trashList(): TrashRecord[] {
    return this.trash.list();
  }

  trashEntries(): TrashEntryDto[] {
    return this.trash.list().map((t) => {
      const rec = this.trashedById.get(t.photoId);
      return toTrashEntryDto(t, rec ? toPhotoDto(rec).ar : undefined);
    });
  }

  /**
   * 移入回收站：成对搬走（RAW/JPEG/侧车一起进 `<照片目录>/.trash/<显示名>/`）。
   * 之所以不搞一个统一的库外回收站：`rename` 只在同一个文件系统里原子，NAS 上尤其如此。
   */
  async moveToTrash(ids: string[]): Promise<OpResultDto> {
    const failed: OpFailureDto[] = [];
    let ok = 0;
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!rec) {
        failed.push({ id, error: this.trashedById.has(id) ? '已经在回收站里了' : '找不到这张照片' });
        continue;
      }
      try {
        await this.trashOne(rec);
        ok++;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (ok) this.reindex();
    return { ok, failed };
  }

  private async trashOne(rec: PhotoRecord): Promise<void> {
    const main = rec.jpeg ?? rec.raw;
    if (!main) throw new Error('这张没有可搬的文件');
    const fromDirAbs = dirname(main.path);
    const trashRoot = join(fromDirAbs, TRASH_DIR);
    const name = uniqueDirName(trashRoot, rec.displayName);
    const target = join(trashRoot, name);
    mkdirSync(target, { recursive: true });

    const oldSidecar = this.sidecarPath(rec);
    const moves: TrashFileMove[] = [];
    const plan = (ref?: FileRef & { ext: string }): (FileRef & { ext: string }) | undefined => {
      if (!ref) return undefined;
      const to = join(target, basename(ref.path));
      moves.push({ from: ref.path, to });
      return { ...ref, path: to };
    };
    const raw = plan(rec.raw);
    const jpeg = plan(rec.jpeg);
    if (oldSidecar && existsSync(oldSidecar)) moves.push({ from: oldSidecar, to: join(target, basename(oldSidecar)) });

    const stars = this.marks.starsOf(rec.id);
    const sizeBytes = (rec.raw?.size ?? 0) + (rec.jpeg?.size ?? 0);

    // 先清标记（回到「未标」）：趁侧车还在原位，XMP 才写得进去。
    // 不清的话，还原之后这张会带着「待删」标记回来 —— 而挑片视图默认隐藏待删，照片就「消失」了。
    if (stars !== 0 || this.marks.delOf(rec.id)) {
      await this.applyMarks([{ id: rec.id, stars: 0, del: false, by: 'me', channel: 'trash' }]);
    }

    const done: TrashFileMove[] = [];
    try {
      for (const mv of moves) {
        moveFile(mv.from, mv.to);
        done.push(mv);
      }
    } catch (err) {
      for (const mv of done.reverse()) {
        try {
          moveFile(mv.to, mv.from);
        } catch {
          // 回滚失败：文件留在回收站里，日志里也不会有它 —— 下次扫描会把位子重算
        }
      }
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // 删不掉空目录不影响正确性
      }
      throw err;
    }

    const moved: PhotoRecord = { ...rec, raw, jpeg, previewPath: jpeg?.path ?? raw?.path ?? rec.previewPath };
    this.records.delete(rec.id);
    this.trashedById.set(rec.id, moved);
    this.trash.add({
      photoId: rec.id,
      displayName: rec.displayName,
      dir: dirPath(rec.rootId, [rec.relDir, TRASH_DIR, name].filter(Boolean).join('/')),
      fromDir: dirPath(rec.rootId, rec.relDir),
      trashedAt: new Date().toISOString(),
      kind: rec.kind,
      ar: toPhotoDto(rec).ar,
      stars: stars > 0 ? stars : undefined,
      hasRaw: Boolean(rec.raw),
      hasJpeg: Boolean(rec.jpeg),
      sizeBytes: sizeBytes || undefined,
      diskDir: target,
      diskFromDir: fromDirAbs,
      rootId: rec.rootId,
      relDir: rec.relDir,
      moves,
    });
  }

  /** 从回收站拿回来：能回原目录就回，位子被占了就排号 —— 绝不覆盖别人的文件 */
  restoreFromTrash(ids: string[]): OpResultDto {
    const failed: OpFailureDto[] = [];
    let ok = 0;
    for (const id of ids) {
      const entry = this.trash.get(id);
      if (!entry) {
        failed.push({ id, error: '回收站里没有这张' });
        continue;
      }
      try {
        this.untrashOne(entry);
        ok++;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (ok) this.reindex();
    return { ok, failed };
  }

  private untrashOne(entry: TrashRecord): void {
    const missing = entry.moves.find((mv) => !existsSync(mv.to));
    if (missing) throw new Error(`回收站里的文件不见了：${basename(missing.to)}`);
    mkdirSync(entry.diskFromDir, { recursive: true });

    const back = new Map<string, string>();
    const done: TrashFileMove[] = [];
    try {
      for (const mv of entry.moves) {
        const dest = uniqueFilePath(mv.from);
        moveFile(mv.to, dest);
        done.push({ from: dest, to: mv.to });
        back.set(mv.to, dest);
      }
    } catch (err) {
      for (const d of done.reverse()) {
        try {
          moveFile(d.from, d.to);
        } catch {
          // 回不去就只能留在原位了
        }
      }
      throw err;
    }

    const rec = this.trashedById.get(entry.photoId);
    if (rec) {
      const fix = <T extends { path: string } | undefined>(ref: T): T =>
        (ref && back.has(ref.path) ? ({ ...ref, path: back.get(ref.path)! } as T) : ref);
      this.records.set(entry.photoId, {
        ...rec,
        raw: fix(rec.raw),
        jpeg: fix(rec.jpeg),
        previewPath: back.get(rec.previewPath) ?? rec.previewPath,
      });
      this.trashedById.delete(entry.photoId);
    }
    this.trash.remove(entry.photoId);
    removeTrashDir(entry.diskDir);
  }

  /** 真删（唯一会 `rmSync` 的地方）。`ids` 为空 = 清空整个回收站。 */
  emptyTrash(ids?: string[]): OpResultDto {
    const wanted = ids && ids.length ? ids : this.trash.list().map((t) => t.photoId);
    const failed: OpFailureDto[] = [];
    let ok = 0;
    for (const id of wanted) {
      const entry = this.trash.get(id);
      if (!entry) {
        failed.push({ id, error: '回收站里没有这张' });
        continue;
      }
      try {
        removeTrashDir(entry.diskDir);
        this.trashedById.delete(id);
        this.trash.remove(id);
        ok++;
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok, failed };
  }

  /**
   * 重启后把关在回收站里的照片重建进内存（只为缩略图/预览还能出图）：
   * 完整元数据已经随扫描丢了，只补路径、类型与尺寸 —— 挑片视图本来也不列已删的。
   */
  private rebuildTrashed(): void {
    for (const entry of this.trash.list()) {
      if (this.trashedById.has(entry.photoId)) continue;
      let raw: (FileRef & { ext: string }) | undefined;
      let jpeg: (FileRef & { ext: string }) | undefined;
      for (const mv of entry.moves) {
        if (!existsSync(mv.to)) continue;
        const name = basename(mv.to);
        const ext = extOf(name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(mv.to);
        } catch {
          continue;
        }
        const ref = { path: mv.to, ext, mtimeMs: st.mtimeMs, size: st.size };
        if (RAW_EXTS.has(ext)) raw = ref;
        else if (IMAGE_EXTS.has(ext)) jpeg = ref;
      }
      if (!raw && !jpeg) continue;
      this.trashedById.set(entry.photoId, {
        id: entry.photoId,
        rootId: entry.rootId,
        relDir: entry.relDir,
        relStem: `${entry.relDir ? `${entry.relDir}/` : ''}${entry.displayName}`,
        displayName: entry.displayName,
        kind: entry.kind,
        raw,
        jpeg,
        previewPath: jpeg?.path ?? raw?.path ?? '',
        previewSource: 'pending',
        meta: {},
        stars: this.marks.starsOf(entry.photoId),
        del: false,
        focusHint: null,
      });
    }
  }

  // ── 标注 ────────────────────────────────────────────────────────────────

  async applyMarks(items: MarkInput[]): Promise<MarkResultDto[]> {
    const results = await this.marks.apply(items, (id) => {
      const rec = this.records.get(id);
      if (!rec) return null;
      return { displayName: rec.displayName, sidecarPath: this.sidecarPath(rec) };
    });
    // 内存里的记录跟着走，免得下次扫描之前列表是旧的
    for (const r of results) {
      const rec = this.records.get(r.id);
      if (!rec) continue;
      rec.stars = r.stars ?? rec.stars;
      rec.del = r.del ?? rec.del;
    }
    return results;
  }

  history(limit?: number, photoId?: string, jobId?: string): MarkChange[] {
    return this.marks.list({ limit, photoId, jobId });
  }

  /** 某个任务写下的全部标注变更（不限条数）：undo 要找「最早的 from」，截断会回滚错 */
  historyForJob(jobId: string): MarkChange[] {
    return this.marks.list({ limit: 0, jobId });
  }

  /**
   * 一张照片当前的标注状态（任务层回流时算 from→to、判断是不是覆盖了别人的批注）。
   * 不认识这张照片返回 null。
   */
  marksOf(photoId: string): { stars: number; del: boolean; by: string | null } | null {
    const rec = this.records.get(photoId);
    if (!rec) return null;
    return { stars: this.marks.starsOf(photoId), del: this.marks.delOf(photoId), by: this.marks.lastBy(photoId) };
  }

  // ── 索引持久化（只为省冷启动的 exiftool；坏了删了都不致命）────────────

  private get indexFile(): string {
    return join(this.cfg.dataDir, 'index.json');
  }

  private loadIndex(): void {
    if (!existsSync(this.indexFile)) return;
    let raw: IndexFile | null = null;
    try {
      raw = JSON.parse(readFileSync(this.indexFile, 'utf8')) as IndexFile;
    } catch {
      return; // 索引坏了不是问题：下次扫描会重建
    }
    if (raw?.version !== INDEX_VERSION) return; // 老版本（或将来更新的）一律丢掉重扫
    for (const [path, entry] of Object.entries(raw.metaCache ?? {})) {
      if (entry && typeof entry.mtimeMs === 'number' && typeof entry.size === 'number') {
        this.metaCache.set(path, entry);
      }
    }
    // 照片列表也恢复：重启后第一眼不用等扫描（尤其是库在 NAS 上时）；后台扫描照旧跑，扫完覆盖
    const records = (raw.records ?? []).filter(isPhotoRecord);
    if (!records.length) return;
    this.records = new Map(records.map((r) => [r.id, r]));
    this.reindex();
    this.rebuildTrashed();
    this.fileCount = typeof raw.fileCount === 'number' ? raw.fileCount : records.length;
    this.lastScanAt = raw.lastScanAt ?? null;
    this.online = new Map(Object.entries(raw.online ?? {}));
    this.rootErrors = new Map(Object.entries(raw.rootErrors ?? {}));
    this.restored = { photos: records.length, savedAt: raw.savedAt ?? null };
  }

  /** 冷启动时从 index.json 恢复的照片数（null = 没有可用缓存）。 */
  get restoredFromCache(): { photos: number; savedAt: string | null } | null {
    return this.restored;
  }

  private saveIndex(): void {
    // 只留当前扫描还见得到的文件（顺手 prune，不会无限膨胀）
    const metaCache: Record<string, CachedMeta> = {};
    for (const rec of this.records.values()) {
      const entry = this.metaCache.get(rec.previewPath);
      if (entry) metaCache[rec.previewPath] = entry;
    }
    try {
      writeFileSync(
        this.indexFile,
        JSON.stringify({
          version: INDEX_VERSION,
          savedAt: new Date().toISOString(),
          lastScanAt: this.lastScanAt,
          fileCount: this.fileCount,
          online: Object.fromEntries(this.online),
          rootErrors: Object.fromEntries(this.rootErrors),
          records: [...this.records.values()],
          metaCache,
        }),
        'utf8',
      );
    } catch {
      // 写不动就算了
    }
  }
}

function byName(a: PhotoRecord, b: PhotoRecord): number {
  return a.displayName.localeCompare(b.displayName, 'en', { numeric: true, sensitivity: 'base' });
}

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
