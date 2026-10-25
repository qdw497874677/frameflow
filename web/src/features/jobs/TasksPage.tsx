import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, ExternalLink, RefreshCw, Undo2, X } from 'lucide-react';
import { cn } from 'cn';
import { jobSource, source } from '@/api';
import { useAppState } from '@/core/store';
import type { Job, JobEvent, Root } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DeliveryStatus } from './DeliveryStatus';
import { describeEvent, eventTone, fmtTime, isActive, itemMark, kindLabel, STATE_LABEL, STATE_TONE } from './jobText';

type Filter = 'all' | 'active' | 'done' | 'ended';

/** 批注任务是谁在标（派发时写进 params.label）：多个任务并列时靠它和人名对上号 */
function jobSubject(job: Job): string {
  const label = job.params?.label;
  return typeof label === 'string' ? label.trim() : '';
}

/**
 * 这一批照片在哪：优先用选择集里的 folder，没有就退到项目名（派发时总带 project）——
 * 同一批人派的多笔任务靠它区分。
 */
function jobDirName(job: Job, roots: Root[]): string {
  const folder = job.selection.where?.folder ?? '';
  const leaf = folder.split('/').filter(Boolean).pop();
  if (leaf) return leaf;
  const rootId = job.selection.project ?? '';
  return roots.find((r) => r.id === rootId)?.label ?? '';
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '进行中' },
  { id: 'done', label: '已完成' },
  { id: 'ended', label: '已取消/失败' },
];

function matchesFilter(job: Job, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'active') return isActive(job.state);
  if (f === 'done') return job.state === 'done';
  return job.state === 'cancelled' || job.state === 'failed';
}

/**
 * 任务页：左边列表（按状态筛）+ 右边详情（进度、items 快照、产物、事件流水）。
 *
 * 数据全部来自 `GET /jobs`、`GET /jobs/{id}`、`GET /jobs/{id}/events?since=` ——
 * 事件用 `nextSince` 当游标增量拉（v1 轮询；形状与将来的 SSE 一致，换传输不改这里）。
 */
export function TasksPage() {
  const { roots } = useAppState();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const sinceRef = useRef(0);
  // 跟着 selectedId 走的 ref：异步响应回来时用它判断「这个结果还属于当前选中的任务吗」
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadList = useCallback(async () => {
    try {
      const list = await jobSource.listJobs({ limit: 100 });
      setJobs(list);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = setInterval(() => void loadList(), 4000);
    return () => clearInterval(t);
  }, [loadList]);

  // 第一次拿到列表：宽屏默认选最新那条（有 ?job= 深链时优先它，方便从派发完成跳过来）；
  // 手机先给列表 —— 一进来就顶到详情、连自己在哪都不知道
  useEffect(() => {
    if (selectedId || jobs.length === 0) return;
    const wanted = new URLSearchParams(window.location.search).get('job');
    if (wanted && jobs.some((j) => j.id === wanted)) {
      setSelectedId(wanted);
      return;
    }
    if (window.matchMedia('(min-width: 768px)').matches) setSelectedId(jobs[0].id);
  }, [jobs, selectedId]);

  // 详情 + 事件：选中即拉，之后每 2.5s 用游标增量拉（事件有新东西时顺带刷新详情）
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setEvents([]);
      return;
    }
    let alive = true;
    sinceRef.current = 0;
    setEvents([]);
    setDetail(null); // 切换任务时先清干净，别让上一条的进度/流水挂在右边
    const tick = async () => {
      try {
        const [job, page] = await Promise.all([
          jobSource.getJob(selectedId),
          jobSource.jobEvents(selectedId, { since: sinceRef.current }),
        ]);
        if (!alive || selectedRef.current !== selectedId) return;
        sinceRef.current = page.nextSince;
        setDetail(job);
        if (page.items.length) setEvents((prev) => [...prev, ...page.items]);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    // 串行循环而不是 setInterval：后端慢过一次 2.5s 时，两个 tick 会读到同一个游标，
    // 把同一批事件追加两次、把 nextSince 回退（任务页的核心信息就是这条流水）
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await tick();
        await new Promise((r) => setTimeout(r, 2500));
      }
    })();
    return () => {
      alive = false;
      stopped = true;
    };
  }, [selectedId]);

  const act = async (fn: () => Promise<Job>) => {
    const id = selectedId;
    setBusy(true);
    try {
      const next = await fn();
      // 发请求期间人可能已经切到别的任务了：别把旧任务的结果盖到新的上面
      if (selectedRef.current === id) setDetail(next);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => jobs.filter((j) => matchesFilter(j, filter)), [jobs, filter]);
  const itemOf = useCallback((id: string) => detail?.items.find((i) => i.id === id), [detail]);
  const undone = events.some((e) => e.type === 'undone');
  const canCancel = detail ? detail.state !== 'done' && detail.state !== 'failed' && detail.state !== 'cancelled' : false;
  // 取消的提示里写着「要退回请 undo」—— 服务端也允许对已取消的任务撤销（只回滚标注，不再迁状态）
  const canUndo = Boolean(detail?.reversible) && !undone;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* 列表 */}
      <div
        className={cn(
          'flex min-h-0 w-full shrink-0 flex-col border-border/60 md:w-80 md:border-r',
          selectedId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex items-center gap-1 px-2 py-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs transition-colors sm:px-2.5 sm:py-1',
                filter === f.id ? 'bg-gold/15 text-gold' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {f.label}
            </button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            onClick={() => void loadList()}
            aria-label="刷新列表"
          >
            <RefreshCw />
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {!loaded ? (
            <p className="px-3 py-6 text-xs text-muted-foreground">正在读任务…</p>
          ) : shown.length === 0 ? (
            <p className="px-3 py-6 text-xs leading-relaxed text-muted-foreground">
              {jobs.length === 0 ? '还没有任务。去「挑片」选好一批，点底部的「派发批注」。' : '这个筛选下没有任务。'}
            </p>
          ) : (
            <ul className="px-1.5 pb-3">
              {shown.map((job) => (
                <li key={job.id}>
                  <button
                    onClick={() => setSelectedId(job.id)}
                    className={cn(
                      'w-full rounded-lg px-2 py-2 text-left transition-colors',
                      job.id === selectedId ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm">
                        {kindLabel(job.kind)}
                        {jobSubject(job) ? <span className="text-muted-foreground"> · {jobSubject(job)}</span> : null}
                      </span>
                      <Badge variant="outline" className={cn('ml-auto', toneClass(STATE_TONE[job.state]))}>
                        {STATE_LABEL[job.state]}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {job.progress.done}/{job.progress.total} · {fmtTime(job.createdAt)}
                      {jobDirName(job, roots) ? ` · ${jobDirName(job, roots)}` : ''}
                    </span>
                    <span className="mt-1 block h-1 overflow-hidden rounded bg-muted-foreground/20">
                      <span
                        className="block h-full rounded bg-gold"
                        style={{ width: `${job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0}%` }}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>

      {/* 详情 */}
      <div className={cn('min-h-0 flex-1 overflow-hidden', selectedId ? 'flex flex-col' : 'hidden md:flex md:flex-col')}>
        {!detail ? (
          <p className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
            左边选一个任务看进度与流水
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto max-w-3xl px-4 py-3 pb-10">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground md:hidden"
                  onClick={() => setSelectedId(null)}
                  aria-label="回到列表"
                >
                  <ArrowLeft />
                </Button>
                <h2 className="text-base font-medium">{kindLabel(detail.kind)}任务</h2>
                <Badge variant="outline" className={toneClass(STATE_TONE[detail.state])}>
                  {STATE_LABEL[detail.state]}
                </Badge>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{detail.id}</span>
              </div>

              <p className="mt-1 text-xs text-muted-foreground">
                {fmtTime(detail.createdAt)} 创建
                {detail.dispatchedAt ? ` · ${fmtTime(detail.dispatchedAt)} 派发` : ''}
                {detail.finishedAt ? ` · ${fmtTime(detail.finishedAt)} 收尾` : ''}
                {jobSubject(detail) ? ` · 批注人 ${jobSubject(detail)}` : ''}
                {detail.channel ? ` · 通道 ${detail.channel}` : ''}
              </p>

              {/* 进度 */}
              <div className="mt-3 rounded-lg border border-border/60 p-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span>进度</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {detail.progress.done}/{detail.progress.total}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted-foreground/20">
                  <div
                    className={cn('h-full rounded', detail.state === 'failed' ? 'bg-destructive' : 'bg-gold')}
                    style={{ width: `${detail.progress.total ? Math.round((detail.progress.done / detail.progress.total) * 100) : 0}%` }}
                  />
                </div>
                {detail.error && <p className="mt-2 text-xs text-destructive">{detail.error}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canCancel || busy}
                    onClick={() => void act(() => jobSource.cancelJob(detail.id))}
                    title={canCancel ? '停在这个状态，批注链接当场失效' : '已经收尾的任务取消不了'}
                  >
                    <X />
                    取消任务
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canUndo || busy}
                    onClick={() => void act(() => jobSource.undoJob(detail.id))}
                    title={
                      !detail.reversible
                        ? '这个任务不可撤销'
                        : undone
                          ? '已经撤销过了'
                          : '把本任务写下的标注回滚到任务开始前'
                    }
                  >
                    <Undo2 />
                    撤销（退回标注）
                  </Button>
                </div>
              </div>

              <DeliveryStatus jobId={detail.id} />

              {/* 产物：批注任务就是那张「打开就能批注」的链接 */}
              {detail.artifacts.length > 0 && (
                <div className="mt-3 rounded-lg border border-border/60 p-3">
                  <p className="text-sm">产物</p>
                  <ul className="mt-2 space-y-1.5">
                    {detail.artifacts.map((a, i) => {
                      const href = a.kind === 'url' ? (a.path.startsWith('http') ? a.path : `${window.location.origin}${a.path}`) : null;
                      return (
                        <li key={`${a.kind}-${i}`} className="flex items-center gap-2 text-xs">
                          <span className="shrink-0 text-muted-foreground">{a.kind === 'url' ? '批注链接' : a.kind}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/70" title={a.path}>
                            {href ?? a.path}
                          </span>
                          {href && (
                            <>
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 shrink-0"
                                onClick={() => void navigator.clipboard.writeText(href)}
                              >
                                <Copy className="size-3.5" />
                                复制链接
                              </Button>
                              <Button variant="ghost" size="icon-sm" asChild aria-label="打开">
                                <a href={href} target="_blank" rel="noreferrer">
                                  <ExternalLink />
                                </a>
                              </Button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    这条链接自带凭据（范围 token）：批注人不用登录，只能看这个任务里的照片、只能写回这个任务。
                  </p>
                </div>
              )}

              {/* items 快照 */}
              <div className="mt-3 rounded-lg border border-border/60 p-3">
                <p className="text-sm">
                  items 快照 <span className="text-xs text-muted-foreground">（创建那刻定下的这一批）</span>
                </p>
                {detail.items.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">这一批是空的。</p>
                ) : (
                  <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {detail.items.map((it) => (
                      <li key={it.id} className="overflow-hidden rounded-md border border-border/60">
                        <img
                          src={source.thumbUrl(it.id, 512)}
                          alt={it.displayName ?? it.id}
                          loading="lazy"
                          decoding="async"
                          className="aspect-square w-full bg-muted object-cover"
                        />
                        <div className="flex items-center gap-1 px-1.5 py-1">
                          <span className="truncate text-[11px]" title={it.displayName ?? it.id}>
                            {it.displayName ?? it.id}
                          </span>
                          <span
                            className={cn(
                              'ml-auto shrink-0 text-[11px]',
                              it.status === 'done' ? 'text-gold' : it.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                            )}
                          >
                            {itemMark(it)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 事件流水 */}
              <div className="mt-3 rounded-lg border border-border/60 p-3">
                <p className="text-sm">
                  事件流水 <span className="text-xs text-muted-foreground">（每 2.5 秒增量拉一次）</span>
                </p>
                {events.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">还没有事件。</p>
                ) : (
                  <ol className="mt-2 space-y-1">
                    {[...events].reverse().map((ev) => (
                      <li key={ev.seq} className="flex items-baseline gap-2 text-xs">
                        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">#{ev.seq}</span>
                        <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{fmtTime(ev.at)}</span>
                        <span className={cn('min-w-0 flex-1 truncate', toneText(eventTone(ev.type)))}>
                          {describeEvent(ev, itemOf)}
                        </span>
                        {ev.by && <span className="shrink-0 text-[11px] text-muted-foreground">{ev.by}</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

function toneClass(tone: 'gold' | 'ok' | 'bad' | 'muted'): string {
  if (tone === 'gold') return 'border-gold/40 text-gold';
  if (tone === 'ok') return 'border-emerald-500/40 text-emerald-500';
  if (tone === 'bad') return 'border-destructive/40 text-destructive';
  return 'text-muted-foreground';
}

function toneText(tone: 'ok' | 'bad' | 'muted' | 'default'): string {
  if (tone === 'ok') return 'text-emerald-500';
  if (tone === 'bad') return 'text-destructive';
  if (tone === 'muted') return 'text-muted-foreground';
  return '';
}
