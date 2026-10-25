import { useEffect } from 'react';
import { toast } from 'sonner';
import { GalleryVerticalEnd, LayoutGrid, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { store, useAppState } from '@/core/store';
import type { Root } from '@/core/types';
import type { View } from '@/core/types';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Toaster } from '@/components/ui/sonner';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar, NAV } from './AppSidebar';
import { Stage } from './Stage';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { TrashPage } from '@/features/trash/TrashPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { TasksPage } from '@/features/jobs/TasksPage';
import { DispatchAnnotateButton } from '@/features/jobs/DispatchAnnotate';

/**
 * 应用外壳：左侧边栏导航（工作区 + 目录树），右侧是当前页面。
 * 挑片页保留自己的顶栏（这一批的账 + 撤销/重置）和底栏（一个看 ⇄ 批量扫 的变焦切换）。
 */
export function App() {
  const { dir, view, mode, notice, error, auth, roots, items, cursor } = useAppState();

  // 首次进入：载入项目并落到第一个有照片的目录；支持 ?dir=/?mode=a|c、?view= 与 ?sel= 深链（截图与分享都靠它）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantedMode = params.get('mode');
    if (wantedMode === 'a' || wantedMode === 'c') store.setMode(wantedMode);
    const wantedView = params.get('view') as View | null;
    const view = wantedView && NAV.some((n) => n.id === wantedView) ? wantedView : undefined;
    if (view) store.setView(view);
    // 选择集（筛选）也进 URL：?sel=del 这类深链刷新/分享出去要能还原
    store.restoreSelectionFromUrl(params.get('sel'));
    void store.boot(params.get('dir') ?? undefined, view);
    // 只跑一次：目录/页面切换都由交互显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  // Shift + ←/→ 变焦（和原型一致的手感）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!e.shiftKey || view !== 'cull') return;
      if (e.key === 'ArrowRight') store.zoomTo('c');
      else if (e.key === 'ArrowLeft') store.zoomTo('a');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const title = NAV.find((n) => n.id === view)?.label ?? '';

  // 后端要密码而还没登：只有一道门，别的什么都不渲染
  if (auth === 'required') {
    return (
      <>
        <LoginScreen />
        <Toaster theme="dark" position="top-center" />
      </>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="flex h-svh min-h-0 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)]">
          <SidebarTrigger className="size-9 text-muted-foreground sm:size-7" />
          <span className="text-sm font-medium">{title}</span>
          {/* 待删筛选：默认列表不含待删，标完就找不到了。有货时出现，点一下只看待删，再点回到全部 */}
          {view === 'cull' && <DelFilterChip />}
          {/* 现在在哪个目录：库名 + 相对子路径。手机也显示（原来 hidden sm:block 手机上完全看不到自己在哪）。
              根的虚拟路径是 /<id>/…，id 是拼音/英文不好认，换成用户超的 label 更直观；悬停吐原始虚拟路径。 */}
          {dir && <DirBadge dir={dir} roots={roots} photoName={view === 'cull' ? items[cursor]?.displayName : undefined} />}
        </header>

        <SaveStatus />
        {view === 'cull' && <CullProgress />}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {view === 'cull' ? (
            <Stage />
          ) : view === 'trash' ? (
            <TrashPage />
          ) : view === 'jobs' ? (
            <TasksPage />
          ) : (
            <SettingsPage />
          )}
        </div>

        {view === 'cull' && (
          <footer className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]">
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">Shift + ←/→ 变焦</span>
            {/* 把眼前这批派给外部批注人：挑片页的选择集直接变成任务的范围 */}
            <DispatchAnnotateButton />
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
            <span className="hidden max-w-[40vw] truncate text-[11px] text-muted-foreground sm:block">
              {notice}
            </span>
          </footer>
        )}

        <Toaster theme="dark" position="top-center" />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * 挑片页的「待删」筛选。
 *
 * 挑片列表默认把待删滤掉（只看剩下要挑的），于是「标完待删就再也看不到那一批」——
 * 这里给它们一个入口：点一下把选择集切成 del=true（走同一套选择集，URL 变成 ?sel=del），再点回到全部。
 */
function SaveStatus() {
  const { saveStatus, saveMessage, localWarning } = useAppState();
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saveStatus === 'saving' || saveStatus === 'error') { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveStatus]);
  if (saveStatus === 'idle' && !localWarning) return null;
  return <div role="status" data-save-status={saveStatus} className={cn('flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs',
    saveStatus === 'error' ? 'text-danger' : 'text-muted-foreground')}>
    <span>{saveMessage}</span>
    {saveStatus === 'error' && <button className="shrink-0 underline" onClick={() => void store.retrySave()}>重试保存</button>}
    {localWarning && <span className="text-danger">浏览器存储不可用，续挑/已看进度无法保留；请勿在标记保存前关闭页面。</span>}
  </div>;
}

function CullProgress() {
  const { items, cursor, total, nextCursor, loading, seen, unseenOnly } = useAppState();
  const seenCount = items.filter(p => seen[p.id]).length;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
    <span className="tabular-nums" data-photo-position>{items[cursor] ? `第 ${cursor + 1} / ${Math.max(total, items.length)} 张` : '没有当前照片'}</span>
    <span title="仅当前浏览器；打标或主动翻过记为已看，打开不算。筛选待删时只统计当前筛选。" data-seen-progress>
      {nextCursor ? '已载入中' : '当前列表'}已看 {seenCount} / {items.length}
    </span>
    <button disabled={loading || !items.length || cursor === 0} className="py-1 disabled:opacity-40" onClick={() => store.skip(-1)}>上一张</button>
    <button disabled={loading || !items[cursor]} className="py-1 disabled:opacity-40" onClick={() => store.skip(1)}>下一张</button>
    <button aria-pressed={unseenOnly} disabled={loading} className={cn('py-1', unseenOnly && 'text-gold')} onClick={() => void store.toggleUnseen()}>{unseenOnly ? '退出未看模式' : '继续未看过'}</button>
    <button className="py-1" onClick={() => {
      if (window.confirm('清除当前项目在本浏览器的已看进度？星级、待删和照片都不会改变。')) store.resetSeen();
    }}>重置已看进度</button>
    <button disabled={loading} className="ml-auto py-1 disabled:opacity-40" onClick={() => void store.reload()}>刷新列表</button>
  </div>;
}

function DelFilterChip() {
  const { selection, pendingTrash } = useAppState();
  const on = selection.where?.del === true;
  const n = pendingTrash.length;
  if (!on && n === 0) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? '回到全部照片' : '只看标了待删、还在原地的照片'}
      onClick={() => void store.toggleDelFilter()}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
        on
          ? 'border-danger/50 bg-danger/15 text-danger'
          : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Trash2 className="size-3" />
      {on ? `只看待删 ${n}` : `待删 ${n}`}
    </button>
  );
}

/** 顶栏的「现在在哪个目录」：/test/2026…/原照片 → 「本地文件 / 2026…/原照片」，一眼知道是哪个库的哪层 */
function DirBadge({ dir, roots, photoName }: { dir: string; roots: Root[]; photoName?: string }) {
  const rootId = dir.split('/')[1] ?? '';
  const root = roots.find((r) => r.id === rootId);
  const rest = dir.split('/').slice(2).join('/');
  return (
    <div className="ml-auto flex min-w-0 flex-1 flex-col items-end gap-0.5 text-xs" title={dir}>
      <span className="max-w-full truncate font-medium" data-current-project={root?.path ?? dir}>
        项目：{root?.label ?? rootId}{rest ? ` / ${rest}` : ''}
      </span>
      {photoName && <span className="max-w-full truncate text-[11px] text-muted-foreground" data-current-photo>{photoName}</span>}
    </div>
  );
}
