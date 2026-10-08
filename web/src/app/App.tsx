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
  const { dir, view, mode, notice, error, auth, roots } = useAppState();

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
          {dir && <DirBadge dir={dir} roots={roots} />}
        </header>

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
function DirBadge({ dir, roots }: { dir: string; roots: Root[] }) {
  const rootId = dir.split('/')[1] ?? '';
  const root = roots.find((r) => r.id === rootId);
  const rest = dir.split('/').slice(2).join('/');
  const text = root ? `${root.label}${rest ? ' / ' + rest : ''}` : dir;
  return (
    <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" title={dir}>
      {text}
    </span>
  );
}
