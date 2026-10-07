import { useEffect } from 'react';
import { toast } from 'sonner';
import { GalleryVerticalEnd, LayoutGrid } from 'lucide-react';
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
          <SidebarTrigger className="text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
          {/* 现在在哪个目录：库名 + 相对子路径。手机也显示（原来 hidden sm:block 手机上完全看不到自己在哪）。
              根的虚拟路径是 /<id>/…，id 是拼音/英文不好认，换成用户超的 label 更直观；悬停吐原始虚拟路径。 */}
          {dir && <DirBadge dir={dir} roots={roots} />}
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {view === 'cull' ? (
            <Stage />
          ) : view === 'trash' ? (
            <TrashPage />
          ) : (
            <SettingsPage />
          )}
        </div>

        {view === 'cull' && (
          <footer className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 pb-[calc(env(safe-area-inset-bottom)+0.375rem)]">
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">Shift + ←/→ 变焦</span>
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
