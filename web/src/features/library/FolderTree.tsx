import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Image, Video } from 'lucide-react';
import { source } from '@/api';
import type { Photo } from '@/core/types';
import { store, useAppState } from '@/core/store';
import { cn } from '@/lib/utils';
import { matchesFileName, projectListVisible } from '@/core/file-search';
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from '@/components/ui/sidebar';

/** 项目 → 目录 → 已识别照片。只加载展开的目录，RAW+JPEG 作为一个照片实体显示。 */
export function FolderTree() {
  const { roots, tree, expanded, dir, view, items, cursor } = useAppState();
  const [flat, setFlat] = useState(() => {
    try { return localStorage.getItem('artworks:sidebar-layout') === 'flat'; } catch { return false; }
  });
  const [layoutWarning, setLayoutWarning] = useState(false);
  const [searching, setSearching] = useState(false);
  const currentPhoto = view === 'cull' ? items[cursor] : undefined;
  const currentId = currentPhoto?.id;
  const currentPath = currentPhoto?.dir;
  const project = roots.filter((root) => root.online && (dir === root.path || dir.startsWith(root.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)[0];

  useEffect(() => {
    if (currentId && currentPath) void store.revealPath(currentPath);
    // Expansion changes deliberately do not retrigger reveal after a manual collapse.
  }, [currentId, currentPath]);

  return (
    <>
      <SidebarMenuSubItem>
        <div role="group" aria-label="项目文件显示方式" className="mx-2 my-2 flex rounded border p-0.5">
          {([false, true] as const).map(value => <button key={String(value)} type="button"
            aria-pressed={flat === value} className={cn('flex-1 rounded px-2 py-1.5 text-xs', flat === value ? 'bg-accent text-foreground' : 'text-muted-foreground')}
            onClick={() => {
              setFlat(value);
              try { localStorage.setItem('artworks:sidebar-layout', value ? 'flat' : 'tree'); setLayoutWarning(false); }
              catch { setLayoutWarning(true); }
            }}>{value ? '全部文件' : '目录树'}</button>)}
        </div>
        {layoutWarning && <p className="px-2 text-xs text-muted-foreground">浏览器存储不可用，显示方式仅本次有效。</p>}
      </SidebarMenuSubItem>
      {project && <ProjectSearch key={project.path} path={project.path} currentId={currentId} onActiveChange={setSearching} />}
      {roots.filter((r) => r.online).map((root) => (
        <Node key={root.path} path={root.path} name={root.label} diskPath={root.diskPath}
          depth={0} isRoot flat={flat} hideContents={root.path === project?.path && !projectListVisible(searching)} projectTotal={root.photoCount} tree={tree} expanded={expanded} currentDir={view === 'cull' ? dir : ''} currentId={currentId} />
      ))}
      {roots.filter((r) => !r.online).map((root) => (
        <SidebarMenuSubItem key={root.path}>
          <div title={root.lastError ?? undefined} className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground/60">
            <Folder className="size-3.5" />
            <span className="truncate">{root.label}</span>
            <span className="ml-auto shrink-0 text-[10px]">未连接</span>
          </div>
          <ProjectProgress path={root.path} total={root.photoCount} offline />
          {root.diskPath && <PathLine path={root.diskPath} />}
        </SidebarMenuSubItem>
      ))}
    </>
  );
}

interface NodeProps {
  path: string;
  name: string;
  diskPath?: string;
  depth: number;
  isRoot?: boolean;
  projectTotal?: number;
  flat?: boolean;
  tree: ReturnType<typeof useAppState>['tree'];
  expanded: Record<string, boolean>;
  currentDir: string;
  currentId?: string;
  /** 侧边栏搜索生效时隐藏项目文件列表（结果列表取而代之） */
  hideContents?: boolean;
}

function Node({ path, name, diskPath, depth, isRoot, projectTotal, flat = false, tree, expanded, currentDir, currentId, hideContents = false }: NodeProps) {
  const listing = tree[path];
  const isOpen = Boolean(expanded[path]);
  const children = listing?.folders ?? [];
  const active = currentDir === path || Boolean(isRoot && currentDir.startsWith(path + '/'));

  return (
    <SidebarMenuSubItem>
        <div className="flex items-center">
          <button type="button" aria-label={`${isOpen ? '收起' : '展开'} ${name}`} aria-expanded={isOpen}
            data-folder-toggle={path}
            className="grid size-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground sm:size-6"
            onClick={() => store.toggleFolder(path)}>
            <ChevronRight className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
          </button>
          <SidebarMenuSubButton asChild isActive={active} className="h-9 min-w-0 flex-1 cursor-pointer sm:h-7">
            <button type="button" data-folder-path={path} aria-current={active ? 'location' : undefined}
              title={`进入${isRoot ? '项目' : '目录'}「${name}」挑片`}
              onClick={() => void store.openFolder(path)}>
              {isRoot || isOpen ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
              <span className="truncate">{name}</span>
              {!isRoot && typeof listing?.photoCount === 'number' && listing.photoCount > 0 && (
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{listing.photoCount}</span>
              )}
            </button>
          </SidebarMenuSubButton>
        </div>
      {isRoot && <ProjectProgress path={path} total={projectTotal} />}
      {isRoot && diskPath && <PathLine path={diskPath} />}
      {isOpen && !hideContents && (
        <SidebarMenuSub>
          {!flat && children.map((child) => (
            <Node key={child.path} path={child.path} name={child.name} depth={depth + 1}
              tree={tree} expanded={expanded} currentDir={currentDir} currentId={currentId} />
          ))}
          <DirectoryPhotos key={`${path}:${flat}`} path={path} currentId={currentId} recursive={flat} />
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}

function ProjectProgress({ path, total, offline = false }: { path: string; total?: number; offline?: boolean }) {
  useAppState();
  const seen = store.projectSeenCount(path);
  const knownTotal = typeof total === 'number';
  const percent = knownTotal && total > 0 ? Math.min(100, Math.round(seen / total * 100)) : 0;
  return <div data-project-progress={path} className="px-7 pb-1 text-[10px] text-muted-foreground"
    title="当前浏览器的已看记录 / 最近扫描的项目总数（含待删）。不受筛选或分页影响；外部移除文件后历史已看记录可能仍保留。">
    <div className="flex justify-between gap-2"><span>已看 {seen} / {knownTotal ? total : '—'}</span><span>{offline ? '离线缓存' : '本机进度'}</span></div>
    {knownTotal && <div role="progressbar" aria-label="项目已看进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      aria-valuetext={`已看 ${seen} / ${total}`} className="mt-1 h-1 overflow-hidden rounded bg-muted">
      <div className="h-full rounded bg-gold transition-[width]" style={{ width: `${percent}%` }} />
    </div>}
  </div>;
}

interface FileListing {
  items: Photo[];
  normalCursor: string | null;
  deletedCursor: string | null;
}

/** 待删也在文件树中可见；两种列表独立分页，点击时由 store 确认照片最新状态。 */
function DirectoryPhotos({ path, currentId, recursive = false }: { path: string; currentId?: string; recursive?: boolean }) {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { items, cursor, view, trash, libraryRevision } = useAppState();
  const current = view === 'cull' ? items[cursor] : undefined;
  // Include a known current photo immediately, even when it lies beyond the loaded pages.
  const visiblePhotos = [...(listing?.items ?? [])];
  if (current && (current.dir === path || (recursive && current.dir.startsWith(path + '/'))) && !visiblePhotos.some((photo) => photo.id === current.id)) visiblePhotos.push(current);
  visiblePhotos.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true }));
  const previousTrash = useRef(trash);
  const request = useRef(0);
  const busy = useRef(false);

  async function load(previous: FileListing | null = null) {
    if (busy.current) return;
    busy.current = true;
    const version = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const [normal, deleted] = await Promise.all([
        !previous || previous.normalCursor
          ? source.listPhotos({ dir: path, recursive, limit: 100, cursor: previous?.normalCursor ?? undefined }) : null,
        !previous || previous.deletedCursor
          ? source.listPhotos({ dir: path, recursive, limit: 100, cursor: previous?.deletedCursor ?? undefined, selection: { where: { del: true } } }) : null,
      ]);
      if (version !== request.current) return;
      const photos = new Map((previous?.items ?? []).map((photo) => [photo.id, photo]));
      for (const photo of [...(normal?.items ?? []), ...(deleted?.items ?? [])]) photos.set(photo.id, photo);
      setListing({
        items: [...photos.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { numeric: true })),
        normalCursor: normal?.nextCursor ?? null,
        deletedCursor: deleted?.nextCursor ?? null,
      });
    } catch (err) {
      if (version === request.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (version === request.current) { busy.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    void load();
    return () => { request.current++; busy.current = false; };
    // 每个目录节点以 path 为 key；收起卸载、重新展开时重新读取文件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, recursive]);

  useEffect(() => {
    const before = previousTrash.current;
    previousTrash.current = trash;
    const oldIds = new Set(before.map((entry) => entry.photoId));
    const newIds = new Set(trash.map((entry) => entry.photoId));
    // Only physical trash/restore changes invalidate membership; marks are overlaid below.
    if ([...before, ...trash].some((entry) => (entry.fromDir === path || (recursive && entry.fromDir.startsWith(path + '/'))) && oldIds.has(entry.photoId) !== newIds.has(entry.photoId))) {
      request.current++;
      busy.current = false;
      setListing(null);
      void load();
    }
    // load belongs to this path; revisions alone must not refetch every expanded directory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trash, libraryRevision, path, recursive]);

  return (
    <>
      {visiblePhotos.map((photo, position) => <PhotoRow key={photo.id} photo={photo} currentId={currentId} position={position} relativeTo={recursive ? path : undefined} />)}
      {!loading && !error && listing && !visiblePhotos.length && <li className="px-7 py-1 text-xs text-muted-foreground">暂无照片或视频</li>}
      {loading && <li className="px-7 py-1 text-[11px] text-muted-foreground" role="status">正在读取照片…</li>}
      {error && <li className="px-7 py-1 text-[11px] text-danger">
        <span>{error}</span>
        <button type="button" className="ml-2 underline" onClick={() => void load(listing)}>重试</button>
      </li>}
      {!error && (listing?.normalCursor || listing?.deletedCursor) && (
        <li><button type="button" disabled={loading} data-tree-more={path}
          className="w-full px-7 py-2 text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={() => void load(listing)}>加载更多照片</button></li>
      )}
    </>
  );
}

/** Search is scoped to the selected project, not just currently expanded folders. */
function ProjectSearch({ path, currentId, onActiveChange }: { path: string; currentId?: string; onActiveChange: (active: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Photo[]>([]);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [seenFilter, setSeenFilter] = useState('all');
  const [rating, setRating] = useState('all');
  const [deletion, setDeletion] = useState('all');
  const [kind, setKind] = useState('all');
  const { trash, seen, markOverrides } = useAppState();
  const filtering = seenFilter !== 'all' || rating !== 'all' || deletion !== 'all' || kind !== 'all';
  // A rating save doesn't change name matches. Only physical removal/restoration does.
  const trashKey = useMemo(() => trash.filter((entry) => entry.fromDir === path || entry.fromDir.startsWith(path + '/'))
    .map((entry) => entry.photoId).sort().join('\n'), [trash, path]);
  const needle = query.trim().toLocaleLowerCase();
  const active = Boolean(needle) || filtering;
  const filtered = results.filter(photo => {
    const mark = markOverrides[photo.id] ?? photo.mark;
    return (seenFilter === 'all' || Boolean(seen[photo.id]) === (seenFilter === 'seen'))
      && (rating === 'all' || (rating === 'starred' ? mark.stars > 0 : mark.stars === Number(rating)))
      && (deletion === 'all' || mark.del === (deletion === 'deleted'))
      && (kind === 'all' || (photo.kind === 'video') === (kind === 'video'));
  });
  useEffect(() => setLimit(100), [seenFilter, rating, deletion, kind]);
  useEffect(() => { onActiveChange(active); }, [active, onActiveChange]);
  useEffect(() => () => onActiveChange(false), [onActiveChange]);

  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setLimit(100);
    setError(null);
    setLoading(active);
    if (!active) return;
    const timer = setTimeout(() => {
      void (async () => {
        const matches = new Map<string, Photo>();
        try {
          // Each stream has its own cursor. Check cancellation before issuing another page.
          for (const del of [false, true]) {
            let cursor: string | undefined;
            do {
              if (cancelled) return;
              const page = await source.listPhotos({ dir: path, recursive: true, limit: 200, cursor,
                selection: { where: { del } } });
              if (cancelled) return;
              for (const photo of page.items) {
                if (!needle || matchesFileName(photo, needle)) matches.set(photo.id, photo);
              }
              setResults([...matches.values()]);
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 200);
    // The source has no AbortSignal; discard in-flight results and stop subsequent pages.
    return () => { cancelled = true; clearTimeout(timer); };
  }, [path, needle, active, retry, trashKey]);

  return (
    <SidebarMenuSubItem>
      <div className="flex items-center gap-1 px-2 py-2">
        <input type="search" aria-label="搜索当前项目文件名" placeholder="搜索当前项目文件名…"
          value={query} onChange={(event) => setQuery(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        {query && <button type="button" aria-label="清除文件搜索" className="px-1 text-xs" onClick={() => setQuery('')}>清除</button>}
      </div>
      <div className="grid grid-cols-2 gap-1 px-2 pb-2">
        <SearchFilter label="筛选已看状态" value={seenFilter} onChange={setSeenFilter} options={[["all", "全部进度"], ["unseen", "未看"], ["seen", "已看"]]} />
        <SearchFilter label="筛选星级" value={rating} onChange={setRating} options={[["all", "全部星级"], ["starred", "有星标"], ["0", "无星标"], ...[1, 2, 3, 4, 5].map(n => [String(n), `${n} 星`] as [string, string])]} />
        <SearchFilter label="筛选待删状态" value={deletion} onChange={setDeletion} options={[["all", "全部（含待删）"], ["normal", "非待删"], ["deleted", "待删"]]} />
        <SearchFilter label="筛选文件类型" value={kind} onChange={setKind} options={[["all", "全部类型"], ["photo", "照片"], ["video", "视频"]]} />
        {filtering && <button type="button" className="col-span-2 py-1 text-xs text-muted-foreground underline" onClick={() => {
          setSeenFilter('all'); setRating('all'); setDeletion('all'); setKind('all');
        }}>重置筛选</button>}
      </div>
      {active && <SidebarMenuSub data-search-results>
        {filtered.slice(0, limit).map((photo) => <PhotoRow key={photo.id} photo={photo} currentId={currentId} />)}
        <li role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {loading ? `正在搜索… 已找到 ${filtered.length} 项` : `找到 ${filtered.length} 项`}
        </li>
        {error && <li className="px-2 text-xs text-danger">{error}
          <button type="button" className="ml-2 underline" onClick={() => setRetry((value) => value + 1)}>重试</button>
        </li>}
        {filtered.length > limit && <li><button type="button" data-tree-more={`search:${path}`}
          className="px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setLimit((value) => value + 100)}>加载更多搜索结果</button></li>}
      </SidebarMenuSub>}
    </SidebarMenuSubItem>
  );
}

function SearchFilter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}
    className="h-8 w-full min-w-0 rounded border bg-background px-1 text-xs focus-visible:ring-2 focus-visible:ring-ring">
    {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </select>;
}

function PhotoRow({ photo, currentId, position, relativeTo }: { photo: Photo; currentId?: string; position?: number; relativeTo?: string }) {
  const { items, seen, markOverrides } = useAppState();
  const live = items.find((item) => item.id === photo.id);
  const mark = markOverrides[photo.id] ?? live?.mark ?? photo.mark;
  const active = currentId === photo.id;
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active && position !== undefined) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, position]);
  const Icon = photo.kind === 'video' ? Video : Image;
  const formats = [photo.rawPath, photo.jpegPath].filter(Boolean)
    .map((file) => file?.split('.').pop()?.toUpperCase()).join('+') || (photo.kind === 'video' ? '视频' : '照片');
  const status = mark.del ? '待删' : mark.stars > 0 ? `★${mark.stars}` : '';
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} className={cn('cursor-pointer pl-7', relativeTo ? 'h-12' : 'h-9 sm:h-7')}>
        <button ref={button} type="button" data-tree-photo={photo.id} aria-current={active ? 'true' : undefined}
          title={`${photo.displayName} · ${formats}\n${photo.dir}\n${status || '未标记'} · ${seen[photo.id] ? '已看' : '未看'}\n点击在所属项目中定位`}
          onClick={() => void store.openPhoto(photo)}>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-xs"><span className="block truncate">{photo.displayName}</span>
            {relativeTo && <span className="block truncate text-[10px] text-muted-foreground" title={photo.dir}>{photo.dir.slice(relativeTo.length + 1) || '项目根目录'}</span>}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground">
            {status && <span className={mark.del ? 'text-danger' : 'text-amber-500'}>{status}</span>}
            <span aria-label={seen[photo.id] ? '已看' : '未看'} title={seen[photo.id] ? '已看' : '未看'}>{seen[photo.id] ? '✓' : '○'}</span>
            <span>{formats}</span>
          </span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function PathLine({ path }: { path: string }) {
  return <div title={path} className="truncate px-7 py-0.5 font-mono text-[10px] leading-4 text-muted-foreground/50">{path}</div>;
}
