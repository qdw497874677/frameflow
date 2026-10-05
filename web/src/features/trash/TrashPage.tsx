import { useState } from 'react';
import { CornerUpLeft, Trash2 } from 'lucide-react';
import { source } from '@/api';
import { store, useAppState } from '@/core/store';
import { formatBytes } from '@/core/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 回收站：产品自己的「已删」区（不是系统废纸篓）。
 * 待删是标记，进这里是明确的二次动作 —— 成对的 RAW+JPEG 一起进来，也能一起回去。
 */
export function TrashPage() {
  const { trash, busy, dir, items } = useAppState();
  const [selected, setSelected] = useState<string[]>([]);
  const bytes = trash.reduce((n, t) => n + (t.sizeBytes ?? 0), 0);
  const pending = items.filter((it) => it.mark.del).length;

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  if (busy && !trash.length) {
    return (
      <div className="grid h-full grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-3/2 rounded-none" />
        ))}
      </div>
    );
  }

  const empty = (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center text-sm text-muted-foreground">
        <Trash2 className="mx-auto mb-3 size-6 opacity-40" />
        回收站是空的。
        <div className="mt-2 text-xs">
          在挑片里标上「待删」的照片还留在原地（只是 tag）—— 点这里的「移入 N 张」才会真搬进来。
        </div>
        {pending > 0 && (
          <Button size="sm" className="mt-3" onClick={() => void store.commitTrash()}>
            <Trash2 className="size-4" />
            把待删的 {pending} 张移入回收站
          </Button>
        )}
      </div>
    </div>
  );

  if (!trash.length) return empty;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <span>
          {trash.length} 张 · {formatBytes(bytes)}
        </span>
        <span className="hidden sm:inline">· 还原回原目录（{dir}）</span>
        <div className="ml-auto flex items-center gap-2">
          {pending > 0 && (
            <Button size="sm" variant="secondary" onClick={() => void store.commitTrash()}>
              <Trash2 className="size-4" />
              移入待删 {pending} 张
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={!selected.length}
            onClick={() => {
              void store.restoreFromTrash(selected);
              setSelected([]);
            }}
          >
            <CornerUpLeft className="size-4" />
            还原 {selected.length || ''}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!selected.length}
            onClick={() => {
              if (window.confirm(`真删选中的 ${selected.length} 张？不可恢复。`)) {
                void store.emptyTrash(selected);
                setSelected([]);
              }
            }}
          >
            <Trash2 className="size-4" />
            真删
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (window.confirm(`确定清空回收站？${trash.length} 张会被真删，不可恢复。`)) void store.emptyTrash();
            }}
          >
            清空
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {trash.map((t) => {
            const on = selected.includes(t.photoId);
            return (
              <Card
                key={t.photoId}
                onClick={() => toggle(t.photoId)}
                className={`cursor-pointer gap-0 overflow-hidden rounded-none border-0 bg-card p-0 ring-1 transition ${
                  on ? 'ring-2 ring-danger' : 'ring-white/10 hover:ring-white/25'
                }`}
              >
                <img
                  src={source.thumbUrl(t.photoId, 512)}
                  alt={t.displayName}
                  className="aspect-3/2 w-full object-cover opacity-70"
                />
                <CardContent className="flex items-center gap-2 p-2 text-[11px]">
                  <span className="truncate">{t.displayName}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{t.fromDir.split('/').pop()}</span>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="mr-2">
          逻辑删除
        </Badge>
        真删之前都能整批还原 —— RAW 与 JPEG 成对进出。
      </div>
    </div>
  );
}
