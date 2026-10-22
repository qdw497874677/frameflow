import { useState } from 'react';
import {
  Aperture,
  FolderPlus,
  Images,
  ListChecks,
  RotateCcw,
  Settings,
  Star,
  Trash2,
  Undo2,
} from 'lucide-react';
import { counts, store, useAppState } from '@/core/store';
import type { View } from '@/core/types';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderTree } from '@/features/library/FolderTree';

/** 侧边栏导航项（顺序就是工作流顺序：挑 → 派活 → 删 → 设置） */
export const NAV: { id: View; label: string; icon: typeof Images }[] = [
  { id: 'cull', label: '挑片', icon: Images },
  { id: 'jobs', label: '批注任务', icon: ListChecks },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'settings', label: '设置', icon: Settings },
];

export function AppSidebar() {
  // 徽标口径：回收站 = 已搬走的 + 还在原地的待删（任何页面上都一致）。
  // 挑片不再挂「当前目录星标数」——那是目录级的数，挂在全局导航上总要解释「这是哪个目录的」。
  const { view, items, trash, pendingTrash, canUndo } = useAppState();
  const c = counts(items);
  const trashCount = pendingTrash.length + trash.length;
  // 新建项目：一个入口、先起名再选目录（以前是两个图标：一个直接挂目录、一个手输路径，都只能事后改名）
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="cursor-default">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-gold/15 text-gold">
                <Aperture className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">art-workspace</span>
                <span className="truncate text-xs text-muted-foreground">挑片 · 回收站</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={view === item.id}
                    onClick={() => store.setView(item.id)}
                    tooltip={item.label}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                  {item.id === 'trash' && trashCount > 0 && (
                    <SidebarMenuBadge className="tabular-nums">{trashCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between gap-2">
            <span className="truncate" title="下面的每个条目是一个项目（映射进来的目录，可改名/移除，见设置页）">
              挑片项目
            </span>
            <button
              type="button"
              aria-label="新建项目"
              title="新建项目：先起名，再选目录"
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setNewProjectOpen(true)}
            >
              <FolderPlus className="size-3.5" />
            </button>
          </SidebarGroupLabel>
          <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
          <SidebarGroupContent>
            <SidebarMenu className="gap-0">
              <FolderTree />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1.5 px-1 pb-1">
          <Badge variant="secondary" className="gap-1 tabular-nums">
            <Star className="size-3 fill-gold text-gold" />
            {c.starred}
          </Badge>
          {/* 待删用后端给的「还在原地的」准数：items 里默认不含待删，从 items 数永远是 0（和上面的回收站徽标会打架） */}
          <Badge variant="secondary" className="gap-1 tabular-nums">
            <Trash2 className="size-3 text-danger" />
            {pendingTrash.length}
          </Badge>
          <Badge variant="outline" className="gap-1 tabular-nums text-muted-foreground">
            未标 {c.none}
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground"
                disabled={!canUndo}
                onClick={() => store.undo()}
                aria-label="撤销"
              >
                <Undo2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>撤销上一步（Ctrl+Z）</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => store.reset()}
                aria-label="重置全部标记"
              >
                <RotateCcw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>重置全部标记</TooltipContent>
          </Tooltip>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
