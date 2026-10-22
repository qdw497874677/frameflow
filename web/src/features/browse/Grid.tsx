import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from 'cn';
import { Maximize2, Play, Star, Trash2 } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import type { Photo } from '@/core/types';
import { source } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Lightbox } from './Lightbox';
import { FOCUS_LABEL } from '@/features/cull/PhotoCard';

/** 点同一颗星循环：0 → 1 → 2 … → 5 → 0，落在一张图上只用一个按钮 */
function cycle(stars: number): number {
  return stars >= 5 ? 0 : stars + 1;
}

type GridCell = { p: Photo; i: number };
type GridRow = { cells: GridCell[]; height: number };

/**
 * 行优先的瀑布：先把一批照片分成「行」，每行按宽高比把可用宽度恰好分完（justified）。
 *
 * 为什么不用 CSS 多列（columns-*）：多列是**列优先**的 —— 视觉上的第一行其实是第 1、4、7 张，
 * 横向扫读会 zig-zag（挑片是横向扫的），底部还会参差不齐。这里按行分组，DOM 顺序 = 阅读顺序，
 * 每行等高、行内按 ar 分宽，一张都不裁。
 */
function buildRows(cells: GridCell[], width: number, target: number, gap: number): GridRow[] {
  if (!width) return [];
  const rows: GridRow[] = [];
  let cur: GridCell[] = [];
  let sum = 0;
  const heightOf = (n: number, s: number) => (width - gap * (n - 1)) / s;

  for (const cell of cells) {
    const ar = cell.p.ar || 1;
    const h = heightOf(cur.length + 1, sum + ar);
    // 带上它这一行会被压得太矮（碰上全景这种极端比例）：先把当前行收了，把它留给下一行
    if (cur.length > 0 && h <= target * 0.55) {
      rows.push({ cells: cur, height: heightOf(cur.length, sum) });
      cur = [cell];
      sum = ar;
      continue;
    }
    cur.push(cell);
    sum += ar;
    if (h <= target) {
      rows.push({ cells: cur, height: h });
      cur = [];
      sum = 0;
    }
  }
  if (cur.length > 0) {
    // 最后一行：凑不满就按目标高度左对齐，别把一张图拉成巨幅
    rows.push({ cells: cur, height: Math.min(target, heightOf(cur.length, sum)) });
  }
  return rows;
}

/**
 * 模式 C：镜头拉远之后的批量扫。
 * 与「一个看」共用同一批数据和同一份标记 —— 这两屏不是两个页面，而是同一画的两种焦距：
 *   - 每格都挂 layoutId，当前那张与卡片流里的顶卡共用同一个 id，所以切换时它自己缩小/长大；
 *   - 点某格 = 镜头推近到它（store.focusAt）；
 *   - 格子上直接打星/待删，不用先放大。
 */
export function Grid() {
  const { items, cursor, mode, centerId, centerToken, flight, nextCursor, loading, unseenOnly, seen } = useAppState();
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 行怎么分要看容器宽度（窗口缩放 / 侧边栏收起都要重排）
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const target = width < 560 ? 150 : width < 1024 ? 190 : 224;
    return buildRows(
      items.map((p, i) => ({ p, i })).filter(({ p }) => !unseenOnly || !seen[p.id]),
      width,
      target,
      8,
    );
  }, [items, width, unseenOnly, seen]);

  // 隐藏层先别加载缩略图：一进目录就是几十张，视频还要 ffmpeg 抽帧。布局照留（aspect-ratio 占位），
  // 所以切过来时的变焦飞行仍然量得到落点。
  const gridVisible = mode !== 'a';
  const [everVisible, setEverVisible] = useState(gridVisible);
  useEffect(() => {
    if (gridVisible) setEverVisible(true);
  }, [gridVisible]);

  // 变焦前先把当前这张摆到视野中央：这样从卡片流缩过来时，它就在原地变小
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !centerId) return;
    const el = list.querySelector<HTMLElement>(`[data-photo="${CSS.escape(centerId)}"]`);
    if (!el) return;
    const c = list.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    list.scrollTop += t.top - c.top - (c.height - t.height) / 2;
  }, [centerId, centerToken]);

  // 从卡片流翻到某一张后回到网格：视角也应该跟着回到那一张
  useEffect(() => {
    if (mode !== 'c' || !centerId) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-photo="${CSS.escape(centerId)}"]`);
    if (!list || !el) return;
    const c = list.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    if (t.top < c.top || t.bottom > c.bottom) {
      list.scrollTo({ top: list.scrollTop + (t.top - c.top) - (c.height - t.height) / 2, behavior: 'smooth' });
    }
  }, [centerId, mode]);

  // 大项目一屏放不下：滚到底自动续页（旁边再放一个按钮兜底 —— 页面本来就没滚到底时也能点）
  useEffect(() => {
    const list = listRef.current;
    const sentinel = sentinelRef.current;
    if (!list || !sentinel || !nextCursor) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void store.loadMore();
      },
      { root: list, rootMargin: '480px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [nextCursor, items.length]);

  return (
    <>
      <div ref={listRef} className="h-full overflow-y-auto overscroll-contain px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
        <div ref={rowsRef} className="flex flex-col gap-2">
          {unseenOnly && !rows.length && !nextCursor && <p className="p-6 text-center text-sm text-muted-foreground">当前列表没有未看过的照片；可退出未看模式复核。</p>}
          {rows.map((row, ri) => (
            <div key={ri} className="flex gap-2" style={{ height: row.height }}>
              {row.cells.map(({ p, i }) => {
                const here = i === cursor;
                return (
                  <motion.div
                    key={p.id}
                    data-photo={p.id}
                    style={{
                      width: row.height * (p.ar || 1),
                      opacity: flight?.id === p.id ? 0 : 1,
                    }}
                    className={cn(
                      'group relative min-w-0 overflow-hidden rounded-none bg-card ring-1 ring-white/10',
                      p.mark.del && 'ring-2 ring-danger/60',
                      here && !p.mark.del && 'ring-2 ring-gold/70',
                    )}
                  >
                <button
                  type="button"
                  onClick={() => store.focusAt(i)}
                  className="block w-full"
                  aria-label={`${p.displayName}（放大看）`}
                >
                  {everVisible ? (
                    <img
                      src={source.thumbUrl(p.id, 512)}
                      alt={p.displayName}
                      className="h-full w-full object-cover"
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                  ) : (
                    <div style={{ aspectRatio: p.ar }} className="w-full bg-muted/30" />
                  )}
                  {p.kind === 'video' && (
                    <span className="pointer-events-none absolute top-1/2 left-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                      <Play className="size-4 fill-white" />
                    </span>
                  )}
                  {p.mark.del && <span className="absolute inset-0 bg-danger/20" />}
                </button>

                {/* 左下角信息：文件名 + 跑焦 */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pt-5 pb-1.5 text-[11px] text-foreground/85">
                  <span className="truncate">{p.displayName}</span>
                  {p.focusHint && p.focusHint !== 'sharp' && (
                    <span className="shrink-0 text-danger">{FOCUS_LABEL[p.focusHint] ?? p.focusHint}</span>
                  )}
                </div>

                {p.mark.stars > 0 && (
                  <Badge className="absolute top-1.5 left-1.5 bg-black/60 text-[11px] text-gold backdrop-blur-sm">
                    {'★'.repeat(p.mark.stars)}
                  </Badge>
                )}

                <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-90">
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    aria-label="看片台"
                    onClick={() => setOpen(i)}
                    className="size-8 bg-black/55 backdrop-blur-sm sm:size-6"
                  >
                    <Maximize2 className="size-4 sm:size-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    aria-label="加星"
                    onClick={() => store.setStars(p.id, p.mark.stars > 0 ? cycle(p.mark.stars) : 1)}
                    className={cn('size-8 bg-black/55 backdrop-blur-sm sm:size-6', p.mark.stars > 0 && 'text-gold')}
                  >
                    <Star className={cn('size-4 sm:size-3.5', p.mark.stars > 0 && 'fill-gold')} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    aria-label="待删"
                    aria-pressed={p.mark.del}
                    onClick={() => store.toggleDel(p.id)}
                    className={cn('size-8 bg-black/55 backdrop-blur-sm sm:size-6', p.mark.del && 'bg-danger/25 text-danger')}
                  >
                    <Trash2 className="size-4 sm:size-3.5" />
                  </Button>
                </div>
                  </motion.div>
                );
              })}
            </div>
          ))}
        </div>
        {nextCursor && (
          <div ref={sentinelRef} className="flex justify-center py-4">
            <Button variant="outline" size="sm" onClick={() => void store.loadMore()} disabled={loading}>
              {loading ? '加载中…' : `加载更多（已载入 ${items.length} 张）`}
            </Button>
          </div>
        )}
      </div>

      <Lightbox items={items} index={open} onClose={() => setOpen(null)} />
    </>
  );
}
