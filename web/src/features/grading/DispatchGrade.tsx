import { useEffect, useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { jobSource } from '@/api';
import { store, useAppState } from '@/core/store';
import type { Job, Look, Selection } from '@/core/types';
import { isRawEmbedded } from './cube';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** 挑片页的「套风格」入口：把当前选择集变成一个 grade 任务，然后去任务页的风格设置阶段 */
export function DispatchGradeButton() {
  const { selection, items, dir } = useAppState();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [looks, setLooks] = useState<Look[]>([]);
  const [look, setLook] = useState<string | null>(null);
  const [keepGps, setKeepGps] = useState(false);

  const rootId = dir?.split('/')[1] ?? '';
  const empty = !selection.where || Object.keys(selection.where).length === 0;
  const scoped: Selection = useMemo(
    () => ({
      ...selection,
      ...(rootId ? { project: rootId } : {}),
      ...(empty && !selection.ids?.length ? { ids: items.map((i) => i.id) } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, rootId, empty, items],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPlan(null);
    // 服务端要求 params.look：先拿风格表，用第一个预演（预演只看张数，风格不影响）
    jobSource
      .listLooks()
      .then((l) => {
        if (!alive) return null;
        setLooks(l);
        setLook((cur) => cur ?? l[0]?.id ?? null);
        return jobSource.planJob({ kind: 'grade', selection: scoped, params: l[0] ? { look: l[0].id } : {} });
      })
      .then((j) => alive && j && setPlan(j), (e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, scoped]);

  const photos = plan?.items.filter((i) => i.status !== 'skipped').length ?? 0;
  const raws = plan?.items.filter(isRawEmbedded).length ?? 0;
  const videos = (plan?.items.length ?? 0) - photos;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const job = await jobSource.createJob({ kind: 'grade', selection: scoped, params: { look, keepGps }, mode: 'apply' });
      setOpen(false);
      store.setView('jobs');
      window.history.replaceState({}, '', `?view=jobs&job=${encodeURIComponent(job.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={items.length === 0}>
        <Palette className="size-3.5" />
        套风格
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>套风格</DialogTitle>
            <DialogDescription>建一个风格任务：在任务页选风格、逐张过目，完成后导出 JPEG 到数据目录（原片不动）。</DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : plan ? (
            <p className="text-sm">
              {photos} 张照片{videos > 0 ? `（另有 ${videos} 个视频会跳过）` : ''}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">预演中…</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {looks.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLook(l.id)}
                title={l.inspiredBy}
                className={cn('rounded-md border px-2 py-1 text-xs', look === l.id ? 'border-gold text-gold' : 'border-border/60 text-muted-foreground')}
              >
                {l.name}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">先定任务默认风格，进去后可逐张改。</p>
          {raws > 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="dispatch-raw-notice">
              其中 {raws} 张只有 RAW：预览与成品都用相机机内内嵌的 JPEG（不做 RAW 解码）。
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={keepGps} onChange={(e) => setKeepGps(e.target.checked)} />
            成品保留 GPS 位置（缺省剥掉；拍摄时间、相机/镜头、作者/版权总会保留）
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button disabled={busy || !plan || photos === 0 || !look} onClick={() => void start()}>开始设置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
