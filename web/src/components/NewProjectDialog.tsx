import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus } from 'lucide-react';
import { store } from '@/core/store';
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
import { DirPicker } from '@/components/DirPicker';

/**
 * 「新建项目」：先起名，再选目录。
 *
 * 项目 = 一个映射进来的目录（不导入、不改目录结构），所以这两件事得一起问：
 * 名字是给人看的（侧边栏那一行、任务落款），目录是给系统看的（扫哪块盘）。
 * 名字留空就用目录名 —— 但不该让人先猜路径再补名字。
 */
export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setName('');
      setDir('');
      setBusy(false);
      setError('');
    }
  }, [open]);

  const base = dir.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '';

  const submit = async () => {
    const path = dir.trim();
    if (!path || busy) return;
    setBusy(true);
    try {
      setError('');
      if (await store.addRoot(path, name.trim() || undefined)) onOpenChange(false);
      else setError(store.getState().notice);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="font-sans sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <FolderPlus className="size-4 text-muted-foreground" />
              新建项目
            </DialogTitle>
            <DialogDescription className="text-xs">
              项目 = 映射进来的一个目录（本地盘、移动硬盘、NAS 都一样）。不导入文件、也不改目录结构。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">项目名称</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={base ? `默认用目录名：${base}` : '例如：2026-冰岛'}
                className="h-8"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">目录</span>
              <div className="flex items-center gap-2">
                <Input
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                  }}
                  placeholder="/home/qdw/Pictures/… 或 ~/nfs/… 挂载点"
                  className="h-8 flex-1 font-mono text-xs"
                  spellCheck={false}
                />
                <Button size="sm" variant="outline" className="h-8 shrink-0" onClick={() => setPickerOpen(true)}>
                  <FolderOpen className="mr-1 size-3.5" />
                  浏览…
                </Button>
              </div>
            </div>
          </div>

          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" disabled={!dir.trim() || busy} onClick={() => void submit()}>
              {busy ? '创建中…' : '创建项目'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DirPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(p) => setDir(p)} />
    </>
  );
}
