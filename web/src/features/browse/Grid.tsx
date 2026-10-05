import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from 'cn';
import { Maximize2, Star, Trash2 } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import { source } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Lightbox } from './Lightbox';
import { FOCUS_LABEL } from '@/features/cull/PhotoCard';

/** 点同一颗星循环：0 → 1 → 2 … → 5 → 0，落在一张图上只用一个按钮 */
function cycle(stars: number): number {
  return stars >= 5 ? 0 : stars + 1;
}

/**
 * 模式 C：镜头拉远之后的批量扫。
 * 与「一个看」共用同一批数据和同一份标记 —— 这两屏不是两个页面，而是同一画的两种焦距：
 *   - 每格都挂 layoutId，当前那张与卡片流里的顶卡共用同一个 id，所以切换时它自己缩小/长大；
 *   - 点某格 = 镜头推近到它（store.focusAt）；
 *   - 格子上直接打星/待删，不用先放大。
 */
export function Grid() {
  const { items, cursor, mode, centerId, centerToken, flight } = useAppState();
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <div ref={listRef} className="h-full overflow-y-auto overscroll-contain px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
        <div className="columns-2 gap-2 sm:columns-3 lg:columns-4 xl:columns-5">
          {items.map((p, i) => {
            const here = i === cursor;
            return (
              <motion.div
                key={p.id}
                data-photo={p.id}
                style={{ opacity: flight?.id === p.id ? 0 : 1 }}
                className={cn(
                  'group relative mb-2 break-inside-avoid overflow-hidden rounded-none bg-card ring-1 ring-white/10',
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
                  <img
                    src={source.thumbUrl(p.id, 512)}
                    alt={p.displayName}
                    style={{ aspectRatio: p.ar }}
                    className="w-full object-cover"
                    draggable={false}
                  />
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
                    className="bg-black/55 backdrop-blur-sm"
                  >
                    <Maximize2 className="size-3.5" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    aria-label="加星"
                    onClick={() => store.setStars(p.id, p.mark.stars > 0 ? cycle(p.mark.stars) : 1)}
                    className={cn('bg-black/55 backdrop-blur-sm', p.mark.stars > 0 && 'text-gold')}
                  >
                    <Star className={cn('size-3.5', p.mark.stars > 0 && 'fill-gold')} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon-xs"
                    aria-label="待删"
                    aria-pressed={p.mark.del}
                    onClick={() => store.toggleDel(p.id)}
                    className={cn('bg-black/55 backdrop-blur-sm', p.mark.del && 'bg-danger/25 text-danger')}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      <Lightbox items={items} index={open} onClose={() => setOpen(null)} />
    </>
  );
}
