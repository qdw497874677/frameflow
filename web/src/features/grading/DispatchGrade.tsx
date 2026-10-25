import { useEffect, useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { jobSource } from '@/api';
import { store, useAppState } from '@/core/store';
import type { Job, Selection } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** 挑片页的「套滤镜」入口：把当前选择集变成一个 grade 任务，然后去任务页的滤镜设置阶段 */
export function DispatchGradeButton() {
  const { selection, items, dir } = useAppState();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    jobSource
      .planJob({ kind: 'grade', selection: scoped, params: {} })
      .then((j) => alive && setPlan(j), (e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [open, scoped]);

  const photos = plan?.items.filter((i) => i.status !== 'skipped').length ?? 0;
  const videos = (plan?.items.length ?? 0) - photos;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const job = await jobSource.createJob({ kind: 'grade', selection: scoped, params: {}, mode: 'apply' });
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
        套滤镜
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>套胶片滤镜</DialogTitle>
            <DialogDescription>建一个滤镜任务：在任务页选风格、逐张过目，完成后导出 JPEG 到数据目录（原片不动）。</DialogDescription>
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
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button disabled={busy || !plan || photos === 0} onClick={() => void start()}>开始设置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
