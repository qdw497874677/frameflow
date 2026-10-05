import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import { cn } from '@/lib/utils';
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from '@/components/ui/sidebar';

/**
 * 侧边栏里的目录树。磁盘是真相，所以树就是导航：
 * 一眼看到「项目 → 设备 → 照片/视频 → 原始/修改后」，点哪就去哪挑。
 * 懒加载：展开一个节点才去读它的子目录（大库下不能一次读全树）。
 */
export function FolderTree() {
  const { roots, tree, expanded, dir, view } = useAppState();

  const online = roots.filter((r) => r.online);
  const offline = roots.filter((r) => !r.online);

  return (
    <>
      {online.map((root) => (
        <Node
          key={root.path}
          path={root.path}
          name={root.label}
          depth={0}
          isRoot
          active={view === 'cull' && dir === root.path}
          tree={tree}
          expanded={expanded}
        />
      ))}
      {offline.map((root) => (
        <div key={root.path} className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground/60">
          <Folder className="size-3.5" />
          <span className="truncate">{root.label}</span>
          <span className="ml-auto shrink-0 text-[10px]">未连接</span>
        </div>
      ))}
    </>
  );
}

interface NodeProps {
  path: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  active: boolean;
  tree: ReturnType<typeof useAppState>['tree'];
  expanded: Record<string, boolean>;
}

function Node({ path, name, depth, isRoot, active, tree, expanded }: NodeProps) {
  const listing = tree[path];
  const isOpen = Boolean(expanded[path]);
  const children = listing?.folders ?? [];
  const count = listing?.photoCount;

  return (
    <SidebarMenuSub className={cn(depth === 0 && 'mx-0 border-l-0 px-0')}>
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          isActive={active}
          onSelect={() => void store.openFolder(path)}
          className="cursor-pointer"
        >
          <button
            type="button"
            aria-label={isOpen ? '收起' : '展开'}
            className="-ml-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              store.toggleFolder(path);
            }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
          </button>
          {isRoot || isOpen ? (
            <FolderOpen className="size-3.5 shrink-0" />
          ) : (
            <Folder className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{name}</span>
          {typeof count === 'number' && count > 0 && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{count}</span>
          )}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
      {isOpen &&
        children.map((child) => (
          <Node
            key={child.path}
            path={child.path}
            name={child.name}
            depth={depth + 1}
            active={false}
            tree={tree}
            expanded={expanded}
          />
        ))}
      {isOpen && listing && children.length === 0 && (
        <div className="px-6 py-1 text-[11px] text-muted-foreground/60">（没有子目录）</div>
      )}
    </SidebarMenuSub>
  );
}
