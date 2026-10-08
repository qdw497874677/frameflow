import { useState } from 'react';
import {
  Aperture,
  FolderOpen,
  FolderPlus,
  Images,
  ListChecks,
  RotateCcw,
  Settings,
  Star,
  Trash2,
  Undo2,
  X,
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
import { DirPicker } from '@/components/DirPicker';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderTree } from '@/features/library/FolderTree';

/** 侧边栏导航项（顺序就是工作流顺序：挑 → 派活 → 删 → 设置） */
export const NAV: { id: View; label: string; icon: typeof Images }[] = [
  { id: 'cull', label: '挑片', icon: Images },
  { id: 'jobs', label: '任务', icon: ListChecks },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'settings', label: '设置', icon: Settings },
];

export function AppSidebar() {
  // 徽标口径：回收站 = 已搬走的 + 还在原地的待删（任何页面上都一致）。
  // 挑片不再挂「当前目录星标数」——那是目录级的数，挂在全局导航上总要解释「这是哪个目录的」。
  const { view, items, trash, pendingTrash, canUndo } = useAppState();
  const c = counts(items);
  const trashCount = pendingTrash.length + trash.length;
  // 就地添加项目：点 + 打开「选目录」（下钻选，或展开一行手输路径）；名字自动用路径末段，想自定义去设置页
  const [addingAt, setAddingAt] = useState(false);
  const [addingPath, setAddingPath] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const submitAdd = async () => {
    const p = addingPath.trim();
    if (!p) return setAddingAt(false);
    setAddingAt(false);
    setAddingPath('');
    await store.addRoot(p);
  };

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
              项目
            </span>
            <button
              type="button"
              aria-label="浏览添加项目"
              title="从文件系统选一个目录挂进左侧树（也可展开手输路径）"
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setPickerOpen(true)}
            >
              <FolderOpen className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="手输路径添加项目"
              title="手动输入绝对路径添加"
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setAddingAt((v) => !v)}
            >
              {addingAt ? <X className="size-3.5" /> : <FolderPlus className="size-3.5" />}
            </button>
          </SidebarGroupLabel>
          <DirPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(p) => void store.addRoot(p)}
          />
          {addingAt && (
            <div className="flex items-center gap-1 px-2 pb-1.5">
              <Input
                autoFocus
                value={addingPath}
                onChange={(e) => setAddingPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAdd();
                  if (e.key === 'Escape') setAddingAt(false);
                }}
                placeholder="绝对路径，回车添加"
                className="h-7 border-dashed bg-transparent font-mono text-xs"
                spellCheck={false}
              />
            </div>
          )}
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
