import { useCallback, useEffect, useState } from 'react';
import { cn } from 'cn';
import { ChevronLeft, ChevronRight, Play, Star, Trash2, X } from 'lucide-react';
import { store } from '@/core/store';
import { source } from '@/api';
import type { Photo } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FOCUS_LABEL } from '@/features/cull/PhotoCard';

interface LightboxProps {
  items: Photo[];
  index: number | null;
  onClose: () => void;
}

/**
 * 看片台：网格里双击一张就进来，连续复查同一批。
 * 打标后自动留在原地（不跳张），用 ←→ 手动翻；删掉的会用红框标出来，方便回头确认。
 */
export function Lightbox({ items, index, onClose }: LightboxProps) {
  const [cursor, setCursor] = useState(index ?? 0);

  useEffect(() => {
    if (index !== null) setCursor(index);
  }, [index]);

  const open = index !== null;
  const photo = items[cursor];

  const step = useCallback(
    (delta: number) => {
      setCursor((c) => Math.min(items.length - 1, Math.max(0, c + delta)));
    },
    [items.length],
  );

  useEffect(() => {
    if (!open || !photo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'z') store.undo();
        return;
      }
      const k = e.key;
      // Shift + ←/→ 留给 App 层的变焦，看片台里不抢
      if (e.shiftKey) return;
      if (k >= '1' && k <= '5') store.setStars(photo.id, Number(k));
      else if (k === '0') store.clearMark(photo.id);
      else if (k.toLowerCase() === 'x') store.toggleDel(photo.id);
      else if (k === 'ArrowRight') step(1);
      else if (k === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, photo, step]);

  if (!photo) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="hidden" />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh max-h-none w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-background/98 p-0 sm:max-w-none"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{photo.displayName}</DialogTitle>
          <DialogDescription>看片台：1-5 打星，0 清星，X 待删，←→ 翻张</DialogDescription>
        </DialogHeader>

        {/* 顶栏 */}
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <Badge variant="secondary" className="tabular-nums">
            {String(cursor + 1).padStart(2, '0')}/{items.length}
          </Badge>
          {photo.camera && (
            <Badge variant="outline" className="text-muted-foreground">
              {photo.camera}
              {photo.lens ? ` · ${photo.lens}` : ''}
            </Badge>
          )}
          {photo.focusHint && photo.focusHint !== 'sharp' && (
            <Badge variant="destructive">{FOCUS_LABEL[photo.focusHint] ?? photo.focusHint}</Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={cursor === 0} aria-label="上一张">
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => step(1)}
              disabled={cursor >= items.length - 1}
              aria-label="下一张"
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭">
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* 大图 */}
        <div className="relative min-h-0 flex-1 bg-black/40">
          <img
            src={source.thumbUrl(photo.id, 2048)}
            alt={photo.displayName}
            className="absolute inset-0 size-full object-contain"
          />
          {photo.kind === 'video' && (
            <span className="pointer-events-none absolute top-1/2 left-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
              <Play className="size-5 fill-white" />
            </span>
          )}
        </div>

        {/* 星级行 */}
        <div className="flex items-center justify-center gap-1 border-t border-border/60 px-3 py-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <Button
              key={n}
              variant="ghost"
              size="icon-lg"
              aria-label={`${n} 星`}
              aria-pressed={n <= photo.mark.stars}
              onClick={() => (photo.mark.stars === n ? store.clearMark(photo.id) : store.setStars(photo.id, n))}
              className={cn('rounded-full text-muted-foreground/70 hover:text-gold', n <= photo.mark.stars && 'text-gold')}
            >
              <Star className={cn('size-5', n <= photo.mark.stars && 'fill-gold')} />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="lg"
            aria-pressed={photo.mark.del}
            onClick={() => store.toggleDel(photo.id)}
            className={cn('ml-2 gap-1.5 text-muted-foreground', photo.mark.del && 'bg-danger/15 text-danger')}
          >
            <Trash2 className="size-4" />
            <span className="text-xs">待删</span>
          </Button>
        </div>

        {/* 胶片条 */}
        <ScrollArea className="border-t border-border/60 pb-[env(safe-area-inset-bottom)]">
          <div className="flex gap-1.5 px-3 py-2">
            {items.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setCursor(i)}
                aria-label={p.displayName}
                className={cn(
                  'relative h-14 shrink-0 overflow-hidden rounded-none ring-1 ring-white/10',
                  i === cursor && 'ring-2 ring-gold',
                )}
              >
                <img
                  src={source.thumbUrl(p.id, 512)}
                  alt=""
                  className="h-14 w-auto object-cover"
                  style={{ aspectRatio: p.ar }}
                  draggable={false}
                />
                {p.mark.del && <span className="absolute inset-0 bg-danger/30" />}
                {p.mark.stars > 0 && (
                  <span className="absolute right-0.5 bottom-0.5 rounded bg-black/60 px-0.5 text-[10px] text-gold">
                    {'★'.repeat(p.mark.stars)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
