import { useEffect } from 'react';
import { toast } from 'sonner';
import { GalleryVerticalEnd, LayoutGrid, RotateCcw, Star, Trash2, Undo2 } from 'lucide-react';
import { counts, store, useAppState } from '@/core/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Stage } from './Stage';

/**
 * 应用外壳：顶栏（这一批的账 + 撤销/重置）、中间舞台、底栏（模式切换）。
 * 模式 A 一次一张专注挑，模式 C 批量扫；两边打的是同一份标记。
 */
export function App() {
  const { dir, items, mode, notice, error, canUndo } = useAppState();
  const c = counts(items);

  // 首次进入：加载根目录 + 支持 ?mode=c 深链（截图与分享都靠它）
  useEffect(() => {
    void store.open(dir);
    const wanted = new URLSearchParams(window.location.search).get('mode');
    if (wanted === 'a' || wanted === 'c') store.setMode(wanted);
    // 只跑一次：目录切换由 open() 显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Shift + ←/→ 变焦（和原型一致的手感）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      if (e.key === 'ArrowRight') store.zoomTo('c');
      else if (e.key === 'ArrowLeft') store.zoomTo('a');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr_auto] overflow-hidden bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)]">
        <Badge variant="secondary" className="gap-1 tabular-nums">
          <Star className="size-3.5 fill-gold text-gold" />
          {c.starred}
        </Badge>
        <Badge variant="secondary" className="gap-1 tabular-nums">
          <Trash2 className="size-3.5 text-danger" />
          {c.trash}
        </Badge>
        <Badge variant="outline" className="gap-1 tabular-nums text-muted-foreground">
          未标 {c.none}
        </Badge>

        <span className="ml-auto hidden truncate text-xs text-muted-foreground sm:block">{dir}</span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => store.undo()}
              disabled={!canUndo}
              aria-label="撤销"
              className="text-muted-foreground"
            >
              <Undo2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>撤销上一步（Ctrl+Z）</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => store.reset()}
              aria-label="重置全部标记"
              className="text-muted-foreground"
            >
              <RotateCcw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>重置全部标记</TooltipContent>
        </Tooltip>
      </header>

      <main className="relative min-h-0 overflow-hidden">
        <Stage />
      </main>

      <footer className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]">
        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">Shift + ←/→ 变焦</span>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && store.zoomTo(v as 'a' | 'c')}
          variant="outline"
          size="sm"
          className="mx-auto"
        >
          <ToggleGroupItem value="a" aria-label="一个看">
            <GalleryVerticalEnd className="size-4" />
            一个看
          </ToggleGroupItem>
          <ToggleGroupItem value="c" aria-label="批量扫">
            <LayoutGrid className="size-4" />
            批量扫
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="hidden max-w-[40vw] truncate text-[11px] text-muted-foreground sm:block">{notice}</span>
      </footer>

      <Toaster theme="dark" position="top-center" />
    </div>
  );
}
