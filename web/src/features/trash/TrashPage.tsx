import { useState } from 'react';
import { Check, CornerUpLeft, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { source } from '@/api';
import { store, useAppState } from '@/core/store';
import { formatBytes } from '@/core/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 回收站：产品自己的「已删」区（不是系统废纸篓）。
 *
 * 两段：上面是**还留在原地的待删**（挑片里打的 tag，文件没动）——
 * 默认列表把待删藏起来，所以这里要单独问一次后端，否则打了 tag 的照片
 * 会既不在挑片里、也不在这里，人就再也够不着它了。
 * 下面是**已经搬进来的**：成对的 RAW+JPEG 一起进来，也能一起回去。
 */
export function TrashPage() {
  const { trash, busy, dir, pendingTrash } = useAppState();
  const [selected, setSelected] = useState<string[]>([]);
  const bytes = trash.reduce((n, t) => n + (t.sizeBytes ?? 0), 0);
  const pending = pendingTrash.length;

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  if (busy && !trash.length && !pending) {
    return (
      <div className="grid h-full grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-3/2 rounded-none" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {pending > 0 && (
        <div className="border-b border-border/60 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              还留在原地的待删 <span className="text-foreground">{pending}</span> 张 —— 只是 tag，文件没动
            </span>
            <Button size="sm" className="ml-auto" onClick={() => void store.commitTrash()}>
              <Trash2 className="size-4" />
              移入回收站 {pending}
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
            {pendingTrash.map((p) => (
              <div key={p.id} className="overflow-hidden bg-card ring-1 ring-white/10">
                <div className="relative">
                  <img
                    src={source.thumbUrl(p.id, 512)}
                    alt={p.displayName}
                    className="aspect-3/2 w-full object-cover opacity-70"
                  />
                  {/* 和下面「已搬进回收站」的卡片长得一样，得标出区别：这批还在原目录 */}
                  <span className="absolute top-1.5 left-1.5 rounded-sm bg-danger/85 px-1 text-[10px] font-medium text-white">
                    待删
                  </span>
                </div>
                <div className="truncate px-1.5 py-1 text-[11px] text-muted-foreground">{p.displayName}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {trash.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <div className="max-w-sm text-center text-sm text-muted-foreground">
            <Trash2 className="mx-auto mb-3 size-6 opacity-40" />
            回收站是空的。
            <div className="mt-2 text-xs">
              {pending > 0
                ? '上面那批还在原目录里 —— 点「移入回收站」才会真搬进来。'
                : '在挑片里标「待删」的照片会先留在原目录，之后可以在这里整批搬进来。'}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
            <span>
              {trash.length} 张 · {formatBytes(bytes)}
            </span>
            <span className="hidden sm:inline">· 点卡片选中（可多选）· 还原回原目录（{dir}）</span>
            <span className="sm:hidden">· 点卡片多选</span>
            <div className="ml-auto flex items-center gap-2">
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
                    <div className="relative">
                      <img
                        src={source.thumbUrl(t.photoId, 512)}
                        alt={t.displayName}
                        className="aspect-3/2 w-full object-cover opacity-70"
                      />
                      {/* 可点选的线索：不选时是暗圈，选中变实心勾（原来只有 hover 的细环，看不出卡片能点） */}
                      <span
                        className={cn(
                          'pointer-events-none absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full border backdrop-blur-sm transition-colors',
                          on
                            ? 'border-danger bg-danger text-white'
                            : 'border-white/45 bg-black/35 text-transparent group-hover:border-white/70',
                        )}
                      >
                        <Check className="size-3.5" />
                      </span>
                      {t.stars > 0 && (
                        <Badge className="absolute top-1.5 left-1.5 bg-black/60 text-[11px] text-gold backdrop-blur-sm">
                          {'★'.repeat(t.stars)}
                        </Badge>
                      )}
                    </div>
                    <CardContent className="flex items-center gap-2 p-2 text-[11px]">
                      <span className="truncate">{t.displayName}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{t.fromDir.split('/').pop()}</span>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <Badge variant="outline" className="mr-2">
          逻辑删除
        </Badge>
        真删之前都能整批还原 —— RAW 与 JPEG 成对进出。
      </div>
    </div>
  );
}
