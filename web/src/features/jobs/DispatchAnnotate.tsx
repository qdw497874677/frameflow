import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Link2, Send, Users } from 'lucide-react';
import { jobSource, source } from '@/api';
import { store, useAppState } from '@/core/store';
import type { Job, Selection } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { isActive } from './jobText';

/**
 * 挑片页的「派发批注」入口：把当前选择集变成一个批注任务。
 *
 * 选择集**直接复用 store 里那一份**（同一份谓词语义，前端不重写）——
 * 只补两件事：① 绑上当前项目（不绑的话服务端会在整个库上求值）；
 * ② 选择集为空时，用「眼前这批」的 id 清单（用户看到什么就派什么）。
 * 预演（plan）由服务端展开 items —— 数字与张数以它为准，不在前端猜。
 */
export function DispatchAnnotateButton() {
  const { selection, items, dir } = useAppState();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('外部批注人');
  const [plan, setPlan] = useState<Job | null>(null);
  const [created, setCreated] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const rootId = dir?.split('/')[1] ?? '';
  const empty = !selection.where || Object.keys(selection.where).length === 0;
  // 预演与实派必须用**同一个**选择集对象：它是 effect 的依赖，每次渲染新建一个的话
  // 预演会反复重来，而依赖数组里只看得到字段列表（selection.ids 变了但 items.length 没变
  // 时预演不刷新）—— 两边会看到不同的张数。
  const scoped: Selection = useMemo(
    () => ({
      ...selection,
      ...(rootId ? { project: rootId } : {}),
      ...(empty && !selection.ids?.length ? { ids: items.map((i) => i.id) } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, rootId, empty, items],
  );
  const scopeText = empty
    ? `眼前这批 ${items.length} 张`
    : `当前筛选（${dir ? dir.split('/').slice(2).join('/') || '项目根' : '项目'}）`;

  // 打开（或选择集变了）就预演一次：服务端把谓词展开成 items 给人看，确认了再派
  useEffect(() => {
    if (!open) {
      setPlan(null);
      setCreated(null);
      setError(null);
      setCopied(false);
      return;
    }
    let alive = true;
    setBusy(true);
    setPlan(null);
    jobSource
      .planJob({ kind: 'annotate', selection: scoped, params: { channel: 'inapp', label } })
      .then((job) => {
        if (!alive) return;
        setPlan(job);
        setError(null);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // label 只在派发时进 params：预演不必随每次击键重来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scoped]);

  const dispatch = async () => {
    // 防重入：同一个标签页里连点两下（或回车 + 点击）会派出两个任务
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const job = await jobSource.createJob({
        kind: 'annotate',
        selection: scoped,
        params: { channel: 'inapp', label: label.trim() || '外部批注人' },
        mode: 'apply',
      });
      setCreated(job);
      setError(null);
      // apply 是异步的：POST 立刻回 queued，链接由 handler 落进 artifacts。
      // 盯到链接出现（或任务收场）为止 —— 别让人对着一句「没有链接产物」发呆。
      let cur = job;
      for (let i = 0; i < 20 && cur.artifacts.length === 0 && isActive(cur.state); i++) {
        await new Promise((r) => setTimeout(r, 600));
        if (!aliveRef.current) return;
        try {
          cur = await jobSource.getJob(job.id);
        } catch (e) {
          // 读不到就说出来（能重试），别静默卡在「链接签发中…」
          if (aliveRef.current) {
            setError(`读不到任务状态：${e instanceof Error ? e.message : String(e)} —— 稍后去任务页看看`);
          }
          return;
        }
        if (aliveRef.current) setCreated(cur);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const link = created?.artifacts.find((a) => a.kind === 'url')?.path ?? '';
  const absolute = link ? (link.startsWith('http') ? link : `${window.location.origin}${link}`) : '';

  const goTasks = () => {
    const id = created?.id;
    setOpen(false);
    store.setView('jobs');
    // 任务页认 ?job= 深链：跳过去直接看这一条
    if (id) window.history.replaceState({}, '', `?view=jobs&job=${encodeURIComponent(id)}`);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        disabled={items.length === 0}
        onClick={() => setOpen(true)}
        title={items.length === 0 ? '这个目录里没有可派的照片' : '把当前选择集派给外部批注人'}
      >
        <Users />
        {/* 手机上底栏也就能放下两个字：图标裸着没人看得懂 */}
        <span className="sm:hidden">派发</span>
        <span className="hidden sm:inline">派发批注</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>派发批注</DialogTitle>
            <DialogDescription>
              给这批照片建一个批注任务，生成一条免登录链接：批注人逐张给星级/待删，结果回流成标注。
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm">
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                  已派发
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {created.progress.total} 张 · 任务 {created.id}
                </span>
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={absolute}>
                  {link || (isActive(created.state) ? '链接签发中…' : '（这个任务没有链接产物）')}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制链接"
                  disabled={!absolute}
                  onClick={() => {
                    void navigator.clipboard.writeText(absolute);
                    setCopied(true);
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
                {absolute ? (
                  <Button variant="ghost" size="icon-sm" asChild aria-label="打开批注页">
                    <a href={absolute} target="_blank" rel="noreferrer">
                      <ExternalLink />
                    </a>
                  </Button>
                ) : (
                  // <Button asChild disabled> 管不到里面的 <a>：没链接时直接渲染一个 disabled 按钮
                  <Button variant="ghost" size="icon-sm" aria-label="打开批注页" disabled>
                    <ExternalLink />
                  </Button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                链接自带凭据（范围 token，30 天）：批注人不用登录、只能看这个任务里的照片、只能写回这个任务。
                撤销签发它的 API token、或取消这个任务，链接立刻失效。
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="annotate-label" className="text-xs text-muted-foreground">
                  批注人（回流记成 <span className="font-mono">link:&lt;批注人&gt;</span>，用来区分是谁标的）
                </label>
                <Input
                  id="annotate-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="外部批注人"
                  maxLength={24}
                />
              </div>

              <div className="rounded-lg border border-border/60 p-3">
                <p className="flex items-baseline gap-2 text-sm">
                  这批
                  <span className="font-mono text-xs text-muted-foreground">
                    {busy && !plan ? '预演中…' : `${plan?.progress.total ?? 0} 张`}
                  </span>
                  <span className="ml-auto truncate text-[11px] text-muted-foreground" title={scopeText}>
                    {scopeText}
                  </span>
                </p>
                {plan && plan.items.length > 0 && (
                  <ul className="mt-2 grid grid-cols-6 gap-1.5">
                    {plan.items.slice(0, 12).map((it) => (
                      <li key={it.id} className="overflow-hidden rounded border border-border/60">
                        <img
                          src={source.thumbUrl(it.id, 512)}
                          alt={it.displayName ?? it.id}
                          loading="lazy"
                          decoding="async"
                          className="aspect-square w-full bg-muted object-cover"
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {plan && plan.items.length > 12 && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">…等 {plan.items.length} 张</p>
                )}
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          )}

          <DialogFooter>
            {created ? (
              <>
                <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
                  关闭
                </Button>
                <Button size="sm" className="h-11 sm:h-9" onClick={goTasks}>
                  去任务页看进度
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => setOpen(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  className="h-11 sm:h-9"
                  disabled={busy || !plan || plan.progress.total === 0}
                  onClick={() => void dispatch()}
                >
                  <Send />
                  派发
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
