import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Star, Trash2, X } from 'lucide-react';
import { cn } from 'cn';
import { annotateSource } from '@/api';
import type { InboundItem, Job, JobItem } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { itemMark } from './jobText';

/** 本地这一张的状态：值 + 发没发出去（没发出去就排队等重发，clientRef 保证重发不重复） */
interface LocalMark {
  stars: number;
  del: boolean;
  status: 'saved' | 'pending' | 'failed';
}

/** 范围 token 的载荷是 `annotate|<jobId>|<别名>|<exp>|<tokenId>`（base64url）——批注页只需要前两段 */
function decodeToken(token: string): { jobId: string; alias: string } | null {
  if (token.startsWith('mock-')) return { jobId: token.slice(5), alias: '外部批注人' };
  try {
    const payload = token.split('.')[0] ?? '';
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const parts = new TextDecoder().decode(bytes).split('|');
    if (parts[0] !== 'annotate' || !parts[1]) return null;
    return { jobId: parts[1], alias: parts[2] || '外部批注人' };
  } catch {
    return null;
  }
}

/**
 * 批注页（`/j?t=<范围 token>`）：给外部批注人的一页，免登录。
 *
 * 凭据就是 URL 里那条 token —— 没有会话、没有 Bearer，所有请求都把 `t=` 带上
 * （缩略图走 `<img>`，图像标签带不上自定义 header，所以凭据必须在 URL 里）。
 * 服务端只放行三件事：读它自己那个任务、看本任务 items 的缩略图、POST 回流。
 */
export function AnnotatePage() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('t') ?? '', []);
  const meta = useMemo(() => decodeToken(token), [token]);

  const [job, setJob] = useState<Job | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'dead' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<string, LocalMark>>({});
  const [pending, setPending] = useState<InboundItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!token || !meta) {
      setPhase('dead');
      return;
    }
    try {
      const j = await annotateSource.getJobForAnnotator(token, meta.jobId);
      setJob(j);
      // 刷新后能看到自己已标的项：初值就从任务 items 读回来
      const init: Record<string, LocalMark> = {};
      j.items.forEach((it) => {
        init[it.id] = { stars: it.stars ?? 0, del: it.del === true, status: 'saved' };
      });
      setMarks(init);
      setPhase('ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 401/403 = 链接失效（任务取消/撤销签发 token/过期），不是网络问题
      if (/401|403|失效|未认证/.test(msg)) setPhase('dead');
      else {
        setPhase('error');
        setError(msg);
      }
    }
  }, [token, meta]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(
    async (items: InboundItem[]) => {
      if (!meta) return;
      setSending(true);
      try {
        await annotateSource.submitInbound(token, meta.jobId, items);
        setMarks((prev) => {
          const next = { ...prev };
          items.forEach((it) => {
            next[it.photoId] = { stars: it.stars ?? 0, del: it.del === true, status: 'saved' };
          });
          return next;
        });
        setPending((prev) => prev.filter((p) => !items.some((i) => i.photoId === p.photoId)));
        setNote(items.length > 1 ? `${items.length} 条已记录` : '已记录');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMarks((prev) => {
          const next = { ...prev };
          items.forEach((it) => {
            next[it.photoId] = { stars: it.stars ?? 0, del: it.del === true, status: 'failed' };
          });
          return next;
        });
        // 没发出去就排队：重发用同一个 clientRef，断网重试不会重复落标
        setPending((prev) => {
          const rest = prev.filter((p) => !items.some((i) => i.photoId === p.photoId));
          return [...rest, ...items];
        });
        setNote(/401|403/.test(msg) ? '链接失效了，改不动了' : '没发出去 —— 网络好了点「重发」');
      } finally {
        setSending(false);
      }
    },
    [meta, token],
  );

  const mark = (item: JobItem, next: { stars: number; del: boolean }) => {
    const prev = marks[item.id];
    if (prev && prev.stars === next.stars && prev.del === next.del) return;
    const stars = next.stars > 0 && next.del ? 0 : next.stars; // 互斥：有星就不算待删
    const final = { stars, del: next.del && stars === 0 ? true : next.del && stars > 0 ? false : next.del };
    setMarks((m) => ({ ...m, [item.id]: { ...final, status: 'pending' } }));
    void send([{ photoId: item.id, stars: final.stars, del: final.del, clientRef: `${item.id}:${final.stars}:${final.del}` }]);
  };

  const items = job?.items ?? [];
  const done = items.filter((it) => {
    const m = marks[it.id];
    return m && (m.stars > 0 || m.del);
  }).length;
  const openIndex = items.findIndex((i) => i.id === openId);
  const current = openIndex >= 0 ? items[openIndex] : null;

  // 看大图时的键盘：←/→ 翻页，1-5 给星，0 取消星，D 待删，Esc 关
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setOpenId(null);
      if (e.key === 'ArrowLeft' && openIndex > 0) return setOpenId(items[openIndex - 1].id);
      if (e.key === 'ArrowRight' && openIndex < items.length - 1) return setOpenId(items[openIndex + 1].id);
      if (/^[0-5]$/.test(e.key)) mark(current, { stars: Number(e.key), del: false });
      if (e.key === 'd' || e.key === 'D') mark(current, { stars: 0, del: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, openIndex, items, marks]);

  if (phase === 'dead') {
    return (
      <Shell>
        <div className="mx-auto max-w-sm px-6 py-20 text-center">
          <h1 className="text-base font-medium">这条批注链接不能用了</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            链接可能已过期、任务被取消，或者签发它的凭据被撤销了。找派发的人要一条新的。
          </p>
        </div>
      </Shell>
    );
  }

  if (phase === 'error') {
    return (
      <Shell>
        <div className="mx-auto max-w-sm px-6 py-20 text-center">
          <h1 className="text-base font-medium">没能打开批注任务</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
            <RefreshCw />
            重试
          </Button>
        </div>
      </Shell>
    );
  }

  if (phase === 'loading' || !job) {
    return (
      <Shell>
        <p className="px-6 py-20 text-center text-sm text-muted-foreground">正在打开…</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/95 px-3 py-2 backdrop-blur pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">批注任务 · {meta?.alias ?? '外部批注人'}</h1>
            <p className="text-[11px] text-muted-foreground">
              已标 {done}/{items.length} · 点一张给星级或标待删
            </p>
          </div>
          <Badge variant="outline" className="ml-auto shrink-0 border-gold/40 text-gold">
            {done}/{items.length}
          </Badge>
        </div>
        {note && <p className="mx-auto mt-1 max-w-3xl text-[11px] text-muted-foreground">{note}</p>}
      </header>

      {pending.length > 0 && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-xs text-destructive">{pending.length} 条没发出去</span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-9"
              disabled={sending}
              onClick={() => void send(pending)}
            >
              <RefreshCw />
              重发
            </Button>
          </div>
        </div>
      )}

      <ul className="mx-auto grid max-w-3xl grid-cols-2 gap-2 px-3 py-3 sm:grid-cols-3">
        {items.map((it) => {
          const m = marks[it.id];
          const marked = m && (m.stars > 0 || m.del);
          return (
            <li key={it.id}>
              <button
                onClick={() => setOpenId(it.id)}
                className={cn(
                  'relative block w-full overflow-hidden rounded-lg border text-left transition-colors',
                  marked ? 'border-gold/60' : 'border-border/60',
                )}
              >
                <img
                  src={annotateSource.thumbUrlForAnnotator(it.id, token, 512)}
                  alt={it.displayName ?? it.id}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full bg-muted object-cover"
                />
                <span className="flex items-center gap-1 px-2 py-1.5">
                  <span className="truncate text-[11px] text-muted-foreground" title={it.displayName ?? it.id}>
                    {it.displayName ?? it.id}
                  </span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 text-[11px]',
                      m?.del ? 'text-destructive' : m?.stars ? 'text-gold' : 'text-muted-foreground',
                    )}
                  >
                    {m?.status === 'pending' ? '…' : m?.status === 'failed' ? '待重发' : itemMark({ ...it, stars: m?.stars ?? 0, del: m?.del ?? false })}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {current && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/98 backdrop-blur">
          <div className="flex items-center gap-2 px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
            <span className="min-w-0 truncate text-sm">{current.displayName ?? current.id}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
              {openIndex + 1}/{items.length}
            </span>
            <Button variant="ghost" size="icon-lg" className="size-11" aria-label="关闭" onClick={() => setOpenId(null)}>
              <X />
            </Button>
          </div>

          <div className="min-h-0 flex-1 px-2">
            <img
              src={annotateSource.thumbUrlForAnnotator(current.id, token, 2048)}
              alt={current.displayName ?? current.id}
              className="mx-auto h-full w-auto max-w-full rounded-lg object-contain"
            />
          </div>

          <div className="px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2">
            <div className="mx-auto flex max-w-md items-center justify-between gap-1">
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-11"
                aria-label="上一张"
                disabled={openIndex <= 0}
                onClick={() => setOpenId(items[openIndex - 1].id)}
              >
                <ChevronLeft />
              </Button>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => {
                  const on = (marks[current.id]?.stars ?? 0) >= n && !marks[current.id]?.del;
                  return (
                    <button
                      key={n}
                      aria-label={`${n} 星`}
                      onClick={() => mark(current, { stars: n, del: false })}
                      className="grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <Star className={cn('size-6', on && 'fill-gold text-gold')} />
                    </button>
                  );
                })}
              </div>
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-11"
                aria-label="下一张"
                disabled={openIndex >= items.length - 1}
                onClick={() => setOpenId(items[openIndex + 1].id)}
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="mx-auto mt-1 flex max-w-md items-center gap-2">
              <Button
                variant={marks[current.id]?.del ? 'default' : 'outline'}
                size="sm"
                className={cn('h-11 flex-1', marks[current.id]?.del && 'bg-destructive text-white hover:bg-destructive/90')}
                onClick={() => mark(current, { stars: 0, del: !marks[current.id]?.del })}
              >
                <Trash2 />
                {marks[current.id]?.del ? '已标待删（点一下取消）' : '标为待删'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-11"
                disabled={(marks[current.id]?.stars ?? 0) === 0 && !marks[current.id]?.del}
                onClick={() => mark(current, { stars: 0, del: false })}
              >
                清除
              </Button>
            </div>
            <p className="mx-auto mt-1.5 max-w-md text-center text-[11px] text-muted-foreground">
              {marks[current.id]?.status === 'saved'
                ? '已记录'
                : marks[current.id]?.status === 'failed'
                  ? '没发出去 —— 关掉这页前记得重发'
                  : '每点一下就会记下（断了网会排队重发）'}
            </p>
          </div>
        </div>
      )}

      <Toaster theme="dark" position="top-center" />
    </Shell>
  );
}

/** 批注页的最小外壳：没有侧栏、没有管理入口 —— 外部批注人只该看到这一件事 */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-svh bg-background text-foreground">{children}</div>;
}
