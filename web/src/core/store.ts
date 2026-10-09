import { useSyncExternalStore } from 'react';
import { source } from '../api';
import { AuthRequiredError } from '../api/source';
import { selectionFromQuery, selectionToQuery } from './selection';
import {
  EMPTY_SELECTION,
  ME,
  NO_MARK,
  type FolderListing,
  type Mark,
  type MarkChange,
  type Photo,
  type Root,
  type Selection,
  type TrashEntry,
  type View,
  type ViewMode,
} from './types';

/**
 * 挑片会话状态（前端唯一可写状态源）。
 * 职责：照片列表、当前游标、打标（星级/待删互斥）、撤销栈、模式切换。
 * 不负责：渲染（组件）、磁盘（后端）、缩略图生成（api 层）。
 */

export type UndoKind = 'stars' | 'del' | 'skip';

export interface UndoEntry {
  kind: UndoKind;
  id: string;
  /** 撤销前的值（stars 为数字，del 为布尔） */
  prev?: number | boolean;
  /** 撤销时卡片回飞方向：1 = 从右回，-1 = 从左回，0 = 淡入 */
  dir: -1 | 0 | 1;
}

/** 视口坐标里的一个矩形（量一次、拿去过动画） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 变焦途中那张「飞着的照片」：从哪起飞、往哪个方向变 */
export interface Flight {
  id: string;
  from: Rect;
  /** 1 = 拉远去网格，-1 = 推近回卡片流 */
  dir: 1 | -1;
}

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

export interface AppState {
  dir: string;
  /** 当前选择集（谓词）：列表里的照片就是它选出来的 —— 也是将来任务的输入 */
  selection: Selection;
  listing: FolderListing | null;
  items: Photo[];
  /** 模式 A 的当前卡片下标 */
  cursor: number;
  mode: ViewMode;
  /** 当前在哪个页面（侧边栏的一项） */
  view: View;
  /**
   * 认证状态。后端开了密码时，没登录的人看到的是登录页而不是空舞台。
   * checking = 还没问过后端；ok = 可以用。
   */
  auth: 'checking' | 'ok' | 'required';
  /** 后端是否开着认证（设置页据此显示「退出登录」） */
  authEnabled: boolean;
  /** 可管理的项目（映射进来的目录） */
  roots: Root[];
  /** 侧边栏目录树：path → 它的子目录（懒加载） */
  tree: Record<string, FolderListing>;
  /** 哪些节点是展开的 */
  expanded: Record<string, boolean>;
  trash: TrashEntry[];
  /**
   * 「还留在原地的待删」：默认列表把待删藏起来（挑片只看剩下的），
   * 所以这个状态得单独问一次后端 —— 否则打了 tag 的照片会既不在挑片里、也不在回收站里。
   */
  pendingTrash: Photo[];
  /** 标注变更日志（最新的在前）：谁、什么时候、把哪个字段从什么改成了什么 */
  history: MarkChange[];
  /** 非挑片页的通用忙标志（载入回收站/规则/预演） */
  busy: boolean;
  loading: boolean;
  error: string | null;
  /** 当前列表还没取完时的下一页游标（null = 已到底） */
  nextCursor: string | null;
  /** 当前作用域里的照片总数（含被默认藏起来的待删），底栏用它说「载入 N/M 张」 */
  total: number;
  /** 底部提示（最近一次动作；供人确认「刚才发生了什么」） */
  notice: string;
  /** 撤销/回退后新卡片的入场方向，与 entryToken 一起构成一次性动画信号 */
  entryDir: -1 | 0 | 1;
  entryToken: number;
  canUndo: boolean;
  /** 变焦去网格时，希望哪一张落在视野中央（同 centerToken 一起构成一次性信号） */
  centerId: string | null;
  centerToken: number;
  /** 正在变焦的「飞卡」；空表示没有变焦在进行 */
  flight: Flight | null;
}

const INITIAL: AppState = {
  dir: '',
  selection: EMPTY_SELECTION,
  listing: null,
  items: [],
  cursor: 0,
  mode: 'a',
  view: 'cull',
  auth: 'checking',
  authEnabled: false,
  roots: [],
  tree: {},
  expanded: { '/photos': true },
  trash: [],
  pendingTrash: [],
  history: [],
  busy: false,
  loading: false,
  error: null,
  nextCursor: null,
  total: 0,
  notice: '',
  entryDir: 0,
  entryToken: 0,
  canUndo: false,
  centerId: null,
  centerToken: 0,
  flight: null,
};

type Listener = () => void;

class AppStore {
  private state: AppState = INITIAL;
  private listeners = new Set<Listener>();
  private undoStack: UndoEntry[] = [];
  private saveTimer: number | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): AppState => this.state;

  private patch(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial, canUndo: this.undoStack.length > 0 };
    this.listeners.forEach((l) => l());
  }

  /* ── 载入 ───────────────────────────────────────────── */

  async open(dir: string, selection?: Selection) {
    const sel = selection ?? this.state.selection;
    this.patch({ dir, selection: sel, loading: true, error: null });
    try {
      const [listing, page] = await Promise.all([
        source.listFolders(dir),
        // 含子目录：目录树的计数是递归的，点项目/中间目录也要能看到里面的照片
        source.listPhotos({ dir, selection: sel, recursive: true }),
      ]);
      this.undoStack = [];
      this.patch({
        listing,
        items: page.items,
        cursor: 0,
        nextCursor: page.nextCursor,
        total: Math.max(page.total ?? page.items.length, listing?.photoCount ?? 0),
        loading: false,
        entryDir: 0,
        entryToken: this.state.entryToken + 1,
      });
      // 列表默认不含待删，所以载入数常常小于目录计数（侧边栏那个）。把两个数一起说，免得看着像丢照片。
      const total = Math.max(page.total ?? page.items.length, listing?.photoCount ?? 0);
      this.flash(total > page.items.length ? `载入 ${page.items.length}/${total} 张 · ${dir}` : `载入 ${page.items.length} 张 · ${dir}`);
      void this.loadPendingTrash();
    } catch (err) {
      this.patch({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 接着往下拿一页（大项目一屏放不下）。网格滚到底时自动叫一次，也可以点「加载更多」。
   */
  async loadMore() {
    const { dir, selection, nextCursor, loading } = this.state;
    if (!nextCursor || loading) return;
    this.patch({ loading: true });
    try {
      const page = await source.listPhotos({ dir, selection, cursor: nextCursor, recursive: true });
      this.patch({
        items: [...this.state.items, ...page.items],
        nextCursor: page.nextCursor,
        loading: false,
      });
    } catch (err) {
      this.patch({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  setMode(mode: ViewMode) {
    if (mode === this.state.mode) return;
    this.patch({ mode });
  }

  /* ── 页面与侧边栏 ─────────────────────────────────── */

  setView(view: View) {
    if (view === this.state.view) return;
    this.patch({ view });
    if (view === 'trash') void this.loadTrash();
    if (view === 'settings') void this.loadMarkHistory();
  }

  /* ── 认证（单用户密码） ─────────────────────────────── */

  /**
   * 问一次后端要不要登录。问不出来（旧后端 / 网络拖一下）就不挡人 ——
   * 真需要鉴权时，后续请求的 401 会再把状态推回 required。
   */
  async checkAuth(): Promise<boolean> {
    try {
      const { required, authed } = await source.authStatus();
      this.patch({ authEnabled: required });
      // 「要不要密码」与「我们现在有没有会话」是两件事：
      // 只看 required 的话，刚登完的人再 boot 一次，会被当前那次未带凭据的探测结果翻回登录页。
      if (!required || authed) {
        this.patch({ auth: 'ok' });
        return true;
      }
      return false;
    } catch {
      this.patch({ authEnabled: false });
      return true;
    }
  }

  /** 登录：密码不对时抛错（调用方显示在表单里） */
  async login(password: string) {
    await source.login(password);
    this.patch({ auth: 'ok', error: null });
    await this.boot(this.state.dir || undefined);
  }

  async logout() {
    await source.logout();
    this.patch({ auth: 'required', items: [], trash: [], pendingTrash: [], history: [], error: null });
  }

  /* ── 选择集（谓词） ─────────────────────────────────── */

  /**
   * 换一个选择集：URL 与列表跟着变。
   * 今天只有设置页与深链在改它；将来「把这一批推给飞书」就是把同一个谓词存进任务。
   */
  async setSelection(selection: Selection) {
    this.patch({ selection });
    this.syncUrl();
    await this.reload();
  }

  /**
   * 深链里的选择集（`?sel=del` / `?sel=stars>=3,marked`）：筛选状态要能从 URL 还原，
   * 分享、收藏和刷新才成立（syncUrl 已经会把它写进去）。
   */
  restoreSelectionFromUrl(q: string | null) {
    if (!q) return;
    this.patch({ selection: selectionFromQuery(q) });
  }

  /**
   * 挑片页顶栏的「待删」筛选。
   *
   * 默认列表把待删藏起来（挑片只看剩下的），于是打完 tag 就再也看不到那一批了。
   * 这里把选择集切成 del=true —— 走的是同一套选择集，所以 URL 会同步成 `?sel=del`，能分享能收藏；
   * 再点一次回到全部。
   */
  async toggleDelFilter() {
    const cur = this.state.selection;
    const where = { ...(cur.where ?? {}) };
    const on = where.del === true;
    if (on) delete where.del;
    else where.del = true;
    const next: Selection = { ...cur, where };
    if (!Object.keys(where).length) delete next.where;
    await this.setSelection(next);
    this.flash(on ? '回到全部照片' : '只看待删（还在原地，没搬进回收站）');
  }

  /** 目录不变、按当前选择集重列（选择集变了，或盘上被外部改过） */
  async reload() {
    const { dir, selection } = this.state;
    this.patch({ loading: true, error: null });
    try {
      const page = await source.listPhotos({ dir, selection, recursive: true });
      this.undoStack = [];
      this.patch({
        items: page.items,
        cursor: 0,
        nextCursor: page.nextCursor,
        total: Math.max(page.total ?? page.items.length, this.state.listing?.photoCount ?? 0),
        loading: false,
        entryDir: 0,
        entryToken: this.state.entryToken + 1,
      });
    } catch (err) {
      this.patch({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 把选择集写进地址栏（分享出去的就是「同一个谓词」，不是一串 id） */
  private syncUrl() {
    try {
      const url = new URL(window.location.href);
      const sel = selectionToQuery(this.state.selection);
      if (sel) url.searchParams.set('sel', sel);
      else url.searchParams.delete('sel');
      window.history.replaceState(null, '', url);
    } catch {
      /* file:// 或受限环境里改不了 URL，忽略 */
    }
  }

  async loadMarkHistory() {
    this.patch({ busy: true });
    try {
      const history = await source.listMarkHistory({ limit: 50 });
      this.patch({ history, busy: false });
    } catch (err) {
      this.patch({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 载入项目列表，并把第一个能用的项目的子目录填进树里 */
  async loadRoots() {
    try {
      const roots = await source.listRoots();
      this.patch({ roots });
      const first = roots.find((r) => r.online);
      if (first) await this.loadTree(first.path);
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 设置页「添加项目」：添加成功后刷新项目列表，并把新根的子目录拉进侧边栏树（展开第一层）。
   * 新根的照片数要等后台扫描，一开始是 0 —— 树先出现，计数随后到位。
   */
  async addRoot(path: string, label?: string) {
    try {
      const root = await source.addRoot({ path, label });
      const roots = await source.listRoots();
      this.patch({ roots, expanded: { ...this.state.expanded, [root.path]: true } });
      await this.loadTree(root.path);
      this.flash(`已添加「${root.label}」；子目录已进入左侧目录树`);
    } catch (err) {
      this.flash(`添加失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 改根显示名（设置页） */
  async renameRoot(id: string, label: string) {
    try {
      const root = await source.renameRoot(id, label);
      this.patch({ roots: this.state.roots.map((r) => (r.id === id ? root : r)) });
      this.flash(`已改名为「${root.label}」`);
    } catch (err) {
      this.flash(`改名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 移除根（设置页）：只解除映射，盘上文件不动。若当前正停在这个根里，
   * 退回到第一个还在线的根，别让舞台停在已被移除的目录上。
   */
  async removeRoot(id: string) {
    try {
      await source.removeRoot(id);
      const roots = await source.listRoots();
      const gone = `/${id}`;
      const tree = Object.fromEntries(Object.entries(this.state.tree).filter(([p]) => !p.startsWith(gone)));
      const expanded = Object.fromEntries(Object.entries(this.state.expanded).filter(([p]) => !p.startsWith(gone)));
      this.patch({ roots, tree, expanded });
      if (this.state.dir.startsWith(gone)) {
        const fallback = roots.find((r) => r.online);
        if (fallback) await this.openFolder(fallback.path);
        else this.patch({ items: [], listing: null, error: null });
      }
      this.flash('已移除（盘上文件未动；重新添加同名路径即可找回）');
    } catch (err) {
      this.flash(`移除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 开箱落点：载入项目 → 从第一个在线项目往下找第一个**真有照片**的目录 →
   * 把树展开到那一层 → 打开它。
   *
   * 为什么不直接打开根：库是按「项目/机身/原照片」分层的，根底下一般一张直属照片都没有，
   * 打开根就是一个空舞台（挑片页会显示「这一批挑完了」，让人以为库是空的）。
   */
  async boot(preferredDir?: string, preferredView?: View) {
    if (!(await this.checkAuth())) {
      this.patch({ auth: 'required' });
      return;
    }
    try {
      // 侧边栏的回收站数字 =「回收站里的」+「还留在原地的待删」。
      // 前者原来是进了回收站页才拉，于是同一个会话里数字会 2 → 4 跳一下；boot 就拉齐，任何页面上都一致。
      // 此刻 dir 还是空的，所以这里只会拉「回收站里的」那半，待删随 open() 之后补上。
      void this.loadTrash();
      await this.loadRoots();
      const roots = this.state.roots;
      const start = preferredDir ?? roots.find((r) => r.online)?.path ?? roots[0]?.path ?? '';
      if (!start) {
        this.patch({ loading: false, error: '还没有项目：先在 artworks.config.yaml 里加一个 roots' });
        return;
      }
      const target = preferredDir ?? (await this.firstDirWithPhotos(start)) ?? start;
      await this.revealPath(target);
      this.patch({ view: preferredView ?? 'cull' });
      await this.open(target);
    } catch (err) {
      if (err instanceof AuthRequiredError) this.patch({ auth: 'required' });
      else this.patch({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 从 path 往下找第一个有照片的目录（含子目录地看，所以项目根自己就算「有照片」）。
   * 深海了就算了，怕库大跑到天荒地老。
   */
  private async firstDirWithPhotos(path: string, depth = 0): Promise<string | null> {
    if (depth > 4) return null;
    try {
      const page = await source.listPhotos({ dir: path, selection: this.state.selection, limit: 1, recursive: true });
      if (page.items.length > 0) return path;
      const listing = await source.listFolders(path);
      for (const kid of listing.folders ?? []) {
        const found = await this.firstDirWithPhotos(kid.path, depth + 1);
        if (found) return found;
      }
    } catch {
      /* 读不动就当这条线没戏 */
    }
    return null;
  }

  /** 让侧边栏把某一层展开着显示：沿祖先链逐层懒加载 */
  async revealPath(path: string) {
    const parts = path.split('/').filter(Boolean);
    const expanded = { ...this.state.expanded };
    for (let i = 1; i <= parts.length; i++) {
      const p = '/' + parts.slice(0, i).join('/');
      expanded[p] = true;
      if (!this.state.tree[p]) await this.loadTree(p);
    }
    this.patch({ expanded });
  }

  private async loadTree(path: string) {
    try {
      const listing = await source.listFolders(path);
      this.patch({ tree: { ...this.state.tree, [path]: listing } });
    } catch (err) {
      this.flash(`目录读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 侧边栏展开/收起一个节点（第一次展开时懒加载） */
  toggleFolder(path: string) {
    const expanded = { ...this.state.expanded, [path]: !this.state.expanded[path] };
    this.patch({ expanded });
    if (expanded[path] && !this.state.tree[path]) void this.loadTree(path);
  }

  /** 打开一个目录：切到挑片页并载入 */
  async openFolder(path: string) {
    this.patch({ view: 'cull' });
    await this.open(path);
  }

  /* ── 回收站 ─────────────────────────────────────────── */

  async loadTrash() {
    this.patch({ busy: true });
    try {
      const dir = this.state.dir;
      const [trash, pending] = await Promise.all([
        source.listTrash(),
        // 没选定目录时不问：后端要求 dir，空串会被 400 顶回来（boot 还没定目录时就是这种状态）
        dir
          ? source.listPhotos({ dir, selection: { ...EMPTY_SELECTION, where: { del: true } }, limit: 500, recursive: true })
          : Promise.resolve({ items: [] as Photo[] }),
      ]);
      // 没定目录时不碰 pendingTrash：boot 的这次调用与 open() 的 loadPendingTrash() 会并发，
      // 后到的空数组会把已经拿到的待删覆盖掉。
      this.patch(dir ? { trash, pendingTrash: pending.items, busy: false } : { trash, busy: false });
    } catch (err) {
      this.patch({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 单独刷新「待删」（打完 tag 之后、换目录之后调用） */
  async loadPendingTrash() {
    if (!this.state.dir) return;
    try {
      const page = await source.listPhotos({
        dir: this.state.dir,
        selection: { ...EMPTY_SELECTION, where: { del: true } },
        limit: 500,
        recursive: true,
      });
      this.patch({ pendingTrash: page.items });
    } catch {
      /* 回收站页会显示错误，这里的失败不影响挑片 */
    }
  }

  /** 把标记为「待删」的整批移到回收站 */
  async commitTrash() {
    const ids = this.state.pendingTrash.map((it) => it.id);
    if (!ids.length) {
      this.flash('没有标为待删的照片');
      return;
    }
    const res = await source.moveToTrash(ids);
    this.patch({
      items: this.state.items.filter((it) => !it.mark.del),
      pendingTrash: [],
      cursor: 0,
    });
    await this.loadTrash();
    this.flash(`已移入回收站 ${res.ok} 张（可整批还原）`);
  }

  async restoreFromTrash(ids: string[]) {
    const res = await source.restore(ids);
    await this.loadTrash();
    this.flash(`已还原 ${res.ok} 张`);
  }

  async emptyTrash(ids?: string[]) {
    const res = await source.emptyTrash(ids);
    await this.loadTrash();
    this.flash(`已真删 ${res.ok} 张（不可恢复）`);
  }

  /**
   * 变焦：一个看 ⇄ 批量扫。两边是同一份数据、同一套标记，所以切换应该是「镜头拉远/推近」
   * 而不是换一页。做法：把一个浮在最上层的「飞卡」从当前卡片的矩形，连续补间到目标格子的
   * 矩形（同时两层各自淡入淡出），落地后由目标那一层接手 —— 全程只有一张照片在动。
   */
  zoomTo(mode: ViewMode) {
    if (mode === this.state.mode) return;
    const it = this.current();

    if (mode === 'c') {
      // 网格一直挂在后台，所以先让它滚到落点（不能居中的情况就滚到能滚的位置），
      // 下一帧量卡片位置再起飞：落点在起飞前就是已知的
      this.patch({ centerId: it?.id ?? null, centerToken: this.state.centerToken + 1 });
      const fly = () => {
        const from = rectOf(document.querySelector('[data-deck-card]'));
        this.patch({ flight: it && from ? { id: it.id, from, dir: 1 } : null, mode: 'c' });
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fly);
      else fly();
      return;
    }

    // 回卡片流：起点是刚刚点的那一格，终点（卡片）要等切完之后才知道，由 FlightOverlay 量
    const from = it ? rectOf(document.querySelector(`[data-photo="${CSS.escape(it.id)}"]`)) : null;
    this.patch({ mode: 'a', flight: it && from ? { id: it.id, from, dir: -1 } : null });
  }

  /** 飞卡落地：交给目标那一层显示 */
  endFlight() {
    if (this.state.flight) this.patch({ flight: null });
  }

  /** 网格里点某张 = 镜头推近到它 */
  focusAt(index: number) {
    const it = this.state.items[index];
    if (!it) return;
    const from = rectOf(document.querySelector(`[data-photo="${CSS.escape(it.id)}"]`));
    this.patch({
      cursor: index,
      mode: 'a',
      entryDir: 0,
      flight: from ? { id: it.id, from, dir: -1 } : null,
    });
  }

  /* ── 打标（星级与待删互斥） ─────────────────────────── */

  setStars(id: string, stars: number, why = '打星') {
    const it = this.find(id);
    if (!it) return;
    const prev = it.mark.stars;
    if (prev === stars) {
      if (stars === 0) return;
      // 再点同一颗星 = 取消
      this.pushUndo({ kind: 'stars', id, prev, dir: 0 });
      this.write(id, { stars: 0, del: false });
      this.flash(`${why}：#${this.label(id)} 清除星标`);
      return;
    }
    this.pushUndo({ kind: 'stars', id, prev, dir: 0 });
    this.write(id, { stars, del: false });
    this.flash(`${why}：#${this.label(id)} → ${'★'.repeat(stars)}`);
  }

  toggleDel(id: string, why = '待删') {
    const it = this.find(id);
    if (!it) return;
    const next = !it.mark.del;
    this.pushUndo({ kind: 'del', id, prev: it.mark.del, dir: 0 });
    this.write(id, { stars: next ? 0 : it.mark.stars, del: next });
    this.flash(next ? `${why}：#${this.label(id)} 🗑 待删` : `${why}：#${this.label(id)} 已恢复`);
  }

  /** 清空当前照片的所有标记 */
  clearMark(id: string) {
    const it = this.find(id);
    if (!it) return;
    if (!it.mark.stars && !it.mark.del) return;
    this.pushUndo({ kind: 'stars', id, prev: it.mark.stars, dir: 0 });
    this.write(id, { stars: 0, del: false });
    this.flash(`清空标记：#${this.label(id)}`);
  }

  /* ── 卡片流：推进 / 撤销 ────────────────────────────── */

  /**
   * 提交一次滑动并推进到下张。
   * @param dir  1 = 右滑（喜欢，用 stars 张数）；-1 = 左滑（待删）
   * @param stars 右滑时的星数（1..5）
   */
  commitSwipe(dir: 1 | -1, stars = 1) {
    const it = this.current();
    if (!it) return;
    if (dir > 0) {
      if (it.mark.stars === 0) {
        this.pushUndo({ kind: 'stars', id: it.id, prev: 0, dir: 1 });
        this.write(it.id, { stars, del: false });
        this.flash(`右滑喜欢 ${stars} 星：#${this.label(it.id)}`);
      } else {
        this.pushUndo({ kind: 'skip', id: it.id, dir: 1 });
        this.flash(`跳过：#${this.label(it.id)}`);
      }
    } else if (!it.mark.del) {
      this.pushUndo({ kind: 'del', id: it.id, prev: false, dir: -1 });
      this.write(it.id, { stars: 0, del: true });
      this.flash(`左滑待删：#${this.label(it.id)} 🗑`);
    } else {
      this.pushUndo({ kind: 'skip', id: it.id, dir: -1 });
      this.flash(`跳过：#${this.label(it.id)}`);
    }
    this.advance(1);
  }

  /** 跳过当前（键盘流里的「下一张」） */
  skip(dir: 1 | -1 = 1) {
    const it = this.current();
    if (!it) return;
    this.pushUndo({ kind: 'skip', id: it.id, dir });
    this.advance(dir);
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) {
      this.flash('没有可撤销的操作');
      return;
    }
    const it = this.find(entry.id);
    if (!it) {
      this.flash('撤销失败：照片已不在列表中');
      return;
    }
    if (entry.kind === 'stars') {
      this.write(entry.id, { stars: Number(entry.prev ?? 0), del: false }, false);
      this.flash(`撤销：#${this.label(entry.id)} 星级 → ${entry.prev ? '★'.repeat(Number(entry.prev)) : '无'}`);
    } else if (entry.kind === 'del') {
      this.write(entry.id, { stars: it.mark.stars, del: Boolean(entry.prev) }, false);
      this.flash(`撤销：#${this.label(entry.id)} ${entry.prev ? '恢复待删' : '取消待删'}`);
    } else {
      this.flash(`撤销：回到 #${this.label(entry.id)}`);
    }
    const index = this.indexOf(entry.id);
    this.patch({
      cursor: index,
      entryDir: entry.dir,
      entryToken: this.state.entryToken + 1,
    });
    this.scheduleSave();
  }

  reset() {
    this.items().forEach((it) => {
      it.mark = { ...NO_MARK };
    });
    this.undoStack = [];
    this.patch({ cursor: 0, entryDir: 0, entryToken: this.state.entryToken + 1 });
    this.flash('已重置全部标记');
    this.scheduleSave();
  }

  /* ── 内部 ───────────────────────────────────────────── */

  current(): Photo | undefined {
    return this.state.items[this.state.cursor];
  }

  indexOf(id: string): number {
    return this.state.items.findIndex((i) => i.id === id);
  }

  private items(): Photo[] {
    return this.state.items;
  }

  private find(id: string): Photo | undefined {
    return this.state.items.find((i) => i.id === id);
  }

  /** 给提示信息用的短标签（显示名末尾序号，便于口头确认） */
  private label(id: string): string {
    const idx = this.indexOf(id);
    const it = this.find(id);
    return `${String(idx + 1).padStart(2, '0')}${it ? ` ${it.displayName}` : ''}`;
  }

  /** 就地更新标记并广播（items 数组本身是可变模型，靠 state 对象换代触发渲染） */
  private write(id: string, mark: Partial<Mark>, broadcast = true) {
    const it = this.find(id);
    if (!it) return;
    it.mark = { stars: mark.stars ?? it.mark.stars, del: mark.del ?? it.mark.del };
    if (it.mark.stars > 0 && it.mark.del) it.mark.del = false; // 不变式：互斥
    if (broadcast) this.patch({});
    this.scheduleSave();
  }

  private pushUndo(entry: UndoEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  private advance(delta: number) {
    this.patch({
      cursor: Math.max(0, Math.min(this.state.items.length, this.state.cursor + delta)),
      entryDir: 0,
    });
  }

  flash(notice: string) {
    this.patch({ notice });
  }

  /** 标记变更合并保存到后端（mock 下写内存日志，真后端追加 marks.jsonl） */
  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const at = new Date().toISOString();
      const payload = this.state.items.map((it) => ({
        id: it.id,
        stars: it.mark.stars,
        del: it.mark.del,
        at,
        by: ME.by,
        channel: ME.channel,
      }));
      void source
        .saveMarks(payload)
        .then(() => this.loadPendingTrash())
        .catch((err: unknown) => this.flash(`保存失败：${err instanceof Error ? err.message : String(err)}`));
    }, 400);
  }
}

export const store = new AppStore();

/** 订阅整个状态（state 对象仅在变更时换代，可安全用于 useSyncExternalStore） */
export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function counts(items: Photo[]): { starred: number; trash: number; none: number } {
  let starred = 0;
  let trash = 0;
  for (const it of items) {
    if (it.mark.del) trash++;
    else if (it.mark.stars > 0) starred++;
  }
  return { starred, trash, none: items.length - starred - trash };
}
