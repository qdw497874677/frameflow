import { ArrowRight, Check, FolderInput, TriangleAlert } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import { formatBytes } from '@/core/format';
import type { ArchiveMove } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

/**
 * 归档：把挑完的这一批按规则搬进目标目录。
 * 关键是「先预演再动手」—— 搬之前把每一条「从哪到哪」摆出来，确认了才真搬（原子）。
 */
export function ArchivePage() {
  const { dir, rules, plan, archiveResult, busy, items } = useAppState();
  const starred = items.filter((i) => i.mark.stars > 0).length;
  const del = items.filter((i) => i.mark.del).length;

  /** 按目标目录归组，让人先看「会分成哪几堆」 */
  const groups = new Map<string, ArchiveMove[]>();
  plan?.moves.forEach((m) => {
    const key = m.to.split('/').slice(0, -1).join('/');
    groups.set(key, [...(groups.get(key) ?? []), m]);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          <span className="text-foreground">{dir}</span> · 这一批 {starred} 张打了星、{del} 张待删
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => store.clearPlan()}>
            清空预演
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void store.planArchive()}>
            <FolderInput className="size-4" />
            预演归档
          </Button>
          <Button size="sm" variant="default" disabled={!plan || busy} onClick={() => void store.applyPlan()}>
            <Check className="size-4" />
            执行 {plan ? `(${plan.moves.length})` : ''}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {del > 0 && (
            <Card className="border-danger/40 bg-danger/5">
              <CardContent className="flex items-center gap-2 p-3 text-xs">
                <TriangleAlert className="size-4 shrink-0 text-danger" />
                还有 {del} 张标着「待删」。待删的不会进归档 —— 先
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-1 text-xs"
                  onClick={() => void store.commitTrash()}
                >
                  移入回收站
                </Button>
                ，归档只处理留下的。
              </CardContent>
            </Card>
          )}

          {archiveResult && (
            <Card className="border-ok/40 bg-ok/5">
              <CardContent className="p-3 text-xs">
                <Check className="mr-1 inline size-4 text-ok" />
                归档完成：搬了 {archiveResult.moved} 张
                {archiveResult.failed.length ? `，${archiveResult.failed.length} 张失败` : '，没有失败'}。
              </CardContent>
            </Card>
          )}

          {!plan && !archiveResult && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">先预演，再动手</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  「预演」按当前启用的 {rules.filter((r) => r.enabled).length} 条规则算出每张照片的目标路径，
                  只读不改盘。看过没问题再点「执行」，后端会以「移动 + 冲突处理」为单位原子完成。
                </p>
                <p>
                  现在启用的规则：
                  {rules.filter((r) => r.enabled).length === 0 ? (
                    <span className="text-danger"> 没有启用的规则，先去「规则」页开一条。</span>
                  ) : (
                    rules
                      .filter((r) => r.enabled)
                      .map((r) => (
                        <Badge key={r.id} variant="secondary" className="ml-1">
                          {r.name}
                        </Badge>
                      ))
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          {plan && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{plan.moves.length} 张要搬</Badge>
                <Badge variant="outline">{formatBytes(plan.totalBytes)}</Badge>
                <Badge variant="outline">分成 {groups.size} 个目标目录</Badge>
                {plan.skipped.length > 0 && <Badge variant="outline">{plan.skipped.length} 张跳过</Badge>}
              </div>

              {[...groups.entries()].map(([target, moves]) => (
                <Card key={target}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 font-mono text-xs font-normal">
                      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{target}</span>
                      <Badge variant="secondary" className="ml-auto shrink-0">
                        {moves.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 pb-3 text-xs">
                    {moves.slice(0, 40).map((m) => (
                      <div key={m.photoId} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 font-mono tabular-nums text-muted-foreground">
                          {m.displayName}
                        </span>
                        <span className="shrink-0 text-muted-foreground">{m.stars > 0 ? '★'.repeat(m.stars) : '—'}</span>
                        <span className="truncate text-muted-foreground/70">来自 {m.from}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">{m.ruleName}</span>
                      </div>
                    ))}
                    {moves.length > 40 && (
                      <div className="pt-1 text-[11px] text-muted-foreground/60">…另有 {moves.length - 40} 张</div>
                    )}
                  </CardContent>
                </Card>
              ))}

              {plan.skipped.length > 0 && (
                <>
                  <Separator />
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-normal text-muted-foreground">
                        跳过 {plan.skipped.length} 张
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-xs text-muted-foreground/80">
                      {plan.skipped.slice(0, 12).map((s) => (
                        <div key={s.photoId} className="flex items-center gap-2">
                          <span className="w-24 shrink-0 font-mono tabular-nums">{s.displayName}</span>
                          <span className="truncate">{s.reason}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
