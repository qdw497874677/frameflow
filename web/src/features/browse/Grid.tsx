import { useState } from 'react';
import { cn } from 'cn';
import { Star, Trash2 } from 'lucide-react';
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
 * 模式 C：批量扫。
 * 一屏几十张，点星即给、点✕即删；双击进看片台放大复查。
 */
export function Grid() {
  const { items } = useAppState();
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      <div className="h-full overflow-y-auto overscroll-contain px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
        <div className="columns-2 gap-2 sm:columns-3 lg:columns-4 xl:columns-5">
          {items.map((p, i) => (
            <div
              key={p.id}
              className={cn(
                'group relative mb-2 break-inside-avoid overflow-hidden rounded-xl ring-1 ring-white/10',
                p.mark.del && 'ring-2 ring-danger/60',
              )}
            >
              <button type="button" onClick={() => setOpen(i)} className="block w-full" aria-label={p.displayName}>
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
                  aria-label="加星"
                  onClick={() => (p.mark.stars > 0 ? store.setStars(p.id, cycle(p.mark.stars)) : store.setStars(p.id, 1))}
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
            </div>
          ))}
        </div>
      </div>

      <Lightbox items={items} index={open} onClose={() => setOpen(null)} />
    </>
  );
}
