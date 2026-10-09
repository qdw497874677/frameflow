import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Folder, FolderOpen, HardDrive, Home } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { source } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

/**
 * 「从文件系统选目录」对话框：后端浏览真实磁盘（只列目录），以文件树呈现 ——
 * 点行选中并展开、点箭头只展开/收起、粘贴路径直接跳，选中即回填。
 * 浏览器原生拿不到服务器上的绝对路径（File System Access API 只给沙箱句柄），
 * 所以走后端 /fs/browse —— 手机浏览器同样可用。
 */

const GVFS = '/run/user/1000/gvfs';

/** 快捷入口：主目录之外，这几个是照片目录常驻的地方（不存在点进去会报错，无害） */
const SHORTCUTS: { icon: LucideIcon; label: string; path: string }[] = [
  { icon: HardDrive, label: '/mnt', path: '/mnt' },
  { icon: HardDrive, label: '/media', path: '/media' },
  { icon: HardDrive, label: '网络挂载', path: GVFS },
];

interface Node {
  parent: string | null;
  dirs: { name: string; path: string }[];
  loading?: boolean;
  error?: string;
}

/** 字符串层面推上一级（节点还没读过时用；'/' 之上没有） */
function parentOf(path: string): string | null {
  const p = path.replace(/\/+$/, '');
  if (!p || p === '/') return null;
  return p.split('/').slice(0, -1).join('/') || '/';
}

export function DirPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (path: string) => void;
}) {
  const [nodes, setNodes] = useState<Record<string, Node>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState('');
  const [home, setHome] = useState('');
  const [extraRoots, setExtraRoots] = useState<string[]>([]);
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);

  const load = useCallback(async (path: string, opts?: { select?: boolean; expand?: boolean }) => {
    setNodes((n) => ({ ...n, [path]: { ...(n[path] ?? { parent: null, dirs: [] }), loading: true, error: undefined } }));
    try {
      const b = await source.browseFs(path);
      setNodes((n) => ({ ...n, [b.path]: { parent: b.parent, dirs: b.dirs } }));
      if (opts?.select) setSelected(b.path);
      if (opts?.expand) setExpanded((e) => ({ ...e, [b.path]: true }));
      return b;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNodes((n) => ({ ...n, [path]: { parent: null, dirs: [], error: message } }));
      return null;
    }
  }, []);

  // 打开时从主目录起步：它就是「默认项目目录」，也正是上一次看的地方
  useEffect(() => {
    if (!open) return;
    setNodes({});
    setExpanded({});
    setExtraRoots([]);
    setJump('');
    setJumpError(null);
    setSelected('');
    void (async () => {
      try {
        const b = await source.browseFs();
        setHome(b.path);
        setNodes({ [b.path]: { parent: b.parent, dirs: b.dirs } });
        setExpanded({ [b.path]: true });
        setSelected(b.path);
      } catch (err) {
        setNodes({ '~': { parent: null, dirs: [], error: err instanceof Error ? err.message : String(err) } });
      }
    })();
  }, [open]);

  const toggle = (path: string) => {
    const next = !expanded[path];
    setExpanded((e) => ({ ...e, [path]: next }));
    setSelected(path);
    if (next && !nodes[path]) void load(path);
  };

  const goUp = () => {
    const target = nodes[selected]?.parent ?? parentOf(selected);
    if (!target) return;
    setSelected(target);
    setExpanded((e) => ({ ...e, [target]: true }));
    if (!nodes[target]) void load(target);
  };

  const jumpTo = async () => {
    const path = jump.trim().replace(/\/+$/, '') || '/';
    if (!path) return;
    setJumpError(null);
    const b = await load(path, { select: true });
    if (!b) {
      setJumpError(`读不了这个目录：${path}`);
      return;
    }
    setExpanded((e) => ({ ...e, [b.path]: true }));
    setExtraRoots((r) => (r.includes(b.path) ? r : [...r, b.path]));
    setJump('');
  };

  const pick = () => {
    if (!selected) return;
    onPick(selected);
    onOpenChange(false);
  };

  const renderRow = (name: string, path: string, depth: number, Icon?: LucideIcon) => {
    const node = nodes[path];
    const isOpen = Boolean(expanded[path]);
    const isSel = selected === path;
    const pad = 4 + depth * 14;
    return (
      <div key={path}>
        <div
          role="treeitem"
          aria-selected={isSel}
          aria-expanded={isOpen}
          title={path}
          className={cn(
            'flex h-7 cursor-pointer items-center gap-1 rounded-sm pr-1.5 text-xs',
            isSel ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
          )}
          style={{ paddingLeft: pad }}
          onClick={() => {
            setSelected(path);
            if (isOpen) {
              toggle(path);
            } else {
              setExpanded((e) => ({ ...e, [path]: true }));
              if (!nodes[path] || nodes[path]?.error) void load(path);
            }
          }}
        >
          <button
            type="button"
            aria-label={isOpen ? '收起' : '展开'}
            className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggle(path);
            }}
          >
            <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
          </button>
          {Icon ? (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : isOpen ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{name}</span>
          {isSel && <Check className="ml-auto size-3.5 shrink-0 text-ok" />}
        </div>
        {isOpen && node?.loading && (
          <div style={{ paddingLeft: pad + 20 }} className="py-1 text-[11px] text-muted-foreground">
            读取中…
          </div>
        )}
        {isOpen && node?.error && (
          <div style={{ paddingLeft: pad + 20 }} className="py-1 text-[11px] text-danger">
            {node.error}
          </div>
        )}
        {isOpen && node && !node.loading && !node.error && node.dirs.map((d) => renderRow(d.name, d.path, depth + 1))}
        {isOpen && node && !node.loading && !node.error && node.dirs.length === 0 && (
          <div style={{ paddingLeft: pad + 20 }} className="py-1 text-[11px] text-muted-foreground/60">
            （没有子目录）
          </div>
        )}
      </div>
    );
  };

  const selName = selected ? selected.split('/').filter(Boolean).pop() || selected : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="font-sans max-h-[85vh] gap-0 p-0 sm:max-w-md"
        // 不让 Radix 自动把焦点丢给第一个快捷按钮：那圈 focus 环看着像「已经选中了 /mnt」
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="size-4 text-muted-foreground" />
            选择目录
          </DialogTitle>
          <DialogDescription className="text-xs">
            展开目录树选一个目录，它会作为一个项目挂进左侧目录树。
          </DialogDescription>
        </DialogHeader>

        {/* 选中路径 + 上一级 + 快捷入口 */}
        <div className="space-y-2 px-4 pt-3">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="outline"
              className="size-7 shrink-0"
              title="上一级"
              disabled={!selected || !(nodes[selected]?.parent ?? parentOf(selected))}
              onClick={goUp}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <span className="flex-1 truncate font-mono text-xs" title={selected}>
              {selected || '读取中…'}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[11px]"
              disabled={!home}
              onClick={() => {
                if (!home) return;
                setSelected(home);
                setExpanded((e) => ({ ...e, [home]: true }));
                if (!nodes[home]) void load(home);
              }}
            >
              <Home className="mr-1 size-3" />
              主目录
            </Button>
            {SHORTCUTS.map((s) => (
              <Button
                key={s.path}
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[11px]"
                onClick={() => void load(s.path, { select: true, expand: true })}
              >
                <s.icon className="mr-1 size-3" />
                {s.label}
              </Button>
            ))}
          </div>
        </div>

        {/* 目录树 */}
        <ScrollArea className="mt-2 h-72 border-y border-border/60">
          <div className="py-1">
            {home ? (
              renderRow('主目录', home, 0, Home)
            ) : nodes['~']?.error ? (
              <div className="px-3 py-2 text-xs text-danger">{nodes['~'].error}</div>
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">读取中…</div>
            )}
            {extraRoots.map((p) => renderRow(p.split('/').filter(Boolean).pop() || p, p, 0))}
            {SHORTCUTS.map((s) => renderRow(s.label, s.path, 0, s.icon))}
          </div>
        </ScrollArea>

        {/* 粘贴跳转 + 确认 */}
        <DialogFooter className="flex-col gap-2 px-4 py-3 sm:flex-col">
          <div className="flex w-full items-center gap-2">
            <Input
              value={jump}
              onChange={(e) => setJump(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void jumpTo()}
              placeholder="或直接粘贴绝对路径，回车跳转"
              className="h-7 flex-1 font-mono text-xs"
              spellCheck={false}
            />
            <Button size="sm" variant="outline" className="h-7" disabled={!jump.trim()} onClick={() => void jumpTo()}>
              跳转
            </Button>
          </div>
          {jumpError && <div className="w-full text-[11px] text-danger">{jumpError}</div>}
          <Button className="h-8 w-full" disabled={!selected} onClick={pick}>
            <Check className="mr-1 size-3.5" />
            {selName ? `选择「${selName}」` : '选择这个目录'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
