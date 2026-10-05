import { useSyncExternalStore } from 'react';
import { source } from '../api';
import {
  NO_MARK,
  type FolderListing,
  type Mark,
  type Photo,
  type Root,
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
  listing: FolderListing | null;
  items: Photo[];
  /** 模式 A 的当前卡片下标 */
  cursor: number;
  mode: ViewMode;
  /** 当前在哪个页面（侧边栏的一项） */
  view: View;
  /** 可管理的根目录 */
  roots: Root[];
  /** 侧边栏目录树：path → 它的子目录（懒加载） */
  tree: Record<string, FolderListing>;
  /** 哪些节点是展开的 */
  expanded: Record<string, boolean>;
  trash: TrashEntry[];
  /** 非挑片页的通用忙标志（载入回收站/规则/预演） */
  busy: boolean;
  loading: boolean;
  error: string | null;
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
  dir: '/photos/2026-冰岛',
  listing: null,
  items: [],
  cursor: 0,
  mode: 'a',
  view: 'cull',
  roots: [],
  tree: {},
  expanded: { '/photos': true },
  trash: [],
  busy: false,
  loading: false,
  error: null,
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

  async open(dir: string) {
    this.patch({ dir, loading: true, error: null });
    try {
      const [listing, page] = await Promise.all([source.listFolders(dir), source.listPhotos({ dir })]);
      this.undoStack = [];
      this.patch({ listing, items: page.items, cursor: 0, loading: false, entryDir: 0, entryToken: this.state.entryToken + 1 });
      this.flash(`载入 ${page.items.length} 张 · ${dir}`);
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
  }

  /** 载入根目录，并把第一个能用的根的子目录填进树里 */
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
      const trash = await source.listTrash();
      this.patch({ trash, busy: false });
    } catch (err) {
      this.patch({ busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 把当前标记为「待删」的整批移到回收站 */
  async commitTrash() {
    const ids = this.state.items.filter((it) => it.mark.del).map((it) => it.id);
    if (!ids.length) {
      this.flash('没有标为待删的照片');
      return;
    }
    const res = await source.moveToTrash(ids);
    this.patch({ items: this.state.items.filter((it) => !it.mark.del), cursor: 0 });
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

  /** 标记变更合并保存到后端（mock 下是空操作） */
  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const payload = this.state.items.map((it) => ({ id: it.id, stars: it.mark.stars, del: it.mark.del }));
      void source
        .saveMarks(payload)
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
