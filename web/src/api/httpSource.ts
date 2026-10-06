import type {
  FolderListingDto,
  MarkChangeDto,
  MarkInputDto,
  MarkResultDto,
  OpResultDto,
  PhotoDto,
  PhotoPageDto,
  RootDto,
  TrashEntryDto,
} from './contract';
import type { ListPhotosOptions, MarkHistoryOptions, PhotoPage, PhotoSource } from './source';
import { AuthRequiredError } from './source';
import { selectionToQuery } from '../core/selection';
import type {
  Folder,
  FolderListing,
  MarkChange,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  TrashEntry,
} from '../core/types';

/** DTO → 领域模型。所有后端字段的兼容处理集中在这里。 */
export function toPhoto(dto: PhotoDto): Photo {
  return {
    id: dto.id,
    dir: dto.dir,
    displayName: dto.displayName,
    kind: dto.kind,
    ar: dto.ar > 0 ? dto.ar : 1,
    width: dto.width,
    height: dto.height,
    camera: dto.camera ?? null,
    lens: dto.lens ?? null,
    hasRaw: Boolean(dto.hasRaw),
    hasJpeg: Boolean(dto.hasJpeg),
    rawPath: dto.rawPath ?? null,
    jpegPath: dto.jpegPath ?? null,
    capturedAt: dto.capturedAt ?? null,
    mtime: dto.mtime,
    sizeBytes: dto.sizeBytes,
    preview: dto.preview,
    focusHint: dto.focusHint ?? null,
    mark: { stars: dto.stars ?? 0, del: Boolean(dto.del) },
  };
}

export function toFolderListing(dto: FolderListingDto): FolderListing {
  const folders: Folder[] = dto.folders.map((f) => ({
    name: f.name,
    path: f.path,
    photoCount: f.photoCount,
    hasSubfolders: f.hasSubfolders,
  }));
  return { path: dto.path, parent: dto.parent ?? null, folders, photoCount: dto.photoCount ?? 0 };
}

export function toMarkInput(input: MarkInput): MarkInputDto {
  const dto: MarkInputDto = { id: input.id };
  if (input.stars !== undefined) dto.stars = input.stars;
  if (input.del !== undefined) dto.del = input.del;
  if (input.at !== undefined) dto.at = input.at;
  if (input.by !== undefined) dto.by = input.by;
  if (input.channel !== undefined) dto.channel = input.channel;
  return dto;
}

export function toMarkChange(dto: MarkChangeDto): MarkChange {
  return {
    photoId: dto.photoId,
    displayName: dto.displayName,
    field: dto.field,
    from: dto.from ?? null,
    to: dto.to ?? null,
    by: dto.by,
    channel: dto.channel,
    at: dto.at,
    jobId: dto.jobId ?? null,
  };
}

export function toRoot(dto: RootDto): Root {
  return {
    id: dto.id,
    path: dto.path,
    label: dto.label || dto.path,
    photoCount: dto.photoCount,
    online: dto.online !== false,
  };
}

export function toTrashEntry(dto: TrashEntryDto): TrashEntry {
  return {
    photoId: dto.photoId,
    displayName: dto.displayName,
    dir: dto.dir,
    fromDir: dto.fromDir,
    trashedAt: dto.trashedAt,
    kind: dto.kind,
    ar: dto.ar > 0 ? dto.ar : 1,
    stars: dto.stars ?? 0,
    hasRaw: Boolean(dto.hasRaw),
    hasJpeg: Boolean(dto.hasJpeg),
    sizeBytes: dto.sizeBytes,
  };
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      /* 非 JSON 错误体，保留状态码 */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 真实后端适配器：严格按 contracts/openapi.yaml 发请求。 */
export function createHttpSource(base = '/api/v1'): PhotoSource {
  return {
    kind: 'http',

    async listRoots() {
      const res = await request<{ roots: RootDto[] }>(base, '/roots');
      return res.roots.map(toRoot);
    },

    async listFolders(path?: string) {
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      return toFolderListing(await request<FolderListingDto>(base, `/folders${q}`));
    },

    async listPhotos(opts: ListPhotosOptions): Promise<PhotoPage> {
      const params = new URLSearchParams({ dir: opts.dir });
      const sel = opts.selection ? selectionToQuery(opts.selection) : '';
      if (sel) params.set('sel', sel);
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.limit) params.set('limit', String(opts.limit));
      const page = await request<PhotoPageDto>(base, `/photos?${params.toString()}`);
      return { items: page.items.map(toPhoto), nextCursor: page.nextCursor ?? null, total: page.total };
    },

    thumbUrl(photoId: string, size: 512 | 2048) {
      return `${base}/photos/${encodeURIComponent(photoId)}/thumb?size=${size}`;
    },

    async saveMarks(items: MarkInput[]): Promise<MarkResult[]> {
      const body = JSON.stringify({ items: items.map(toMarkInput) });
      const res = await request<{ results: MarkResultDto[] }>(base, '/marks', { method: 'PUT', body });
      return res.results.map((r) => ({ id: r.id, ok: r.ok, error: r.error ?? null }));
    },

    async listMarkHistory(opts?: MarkHistoryOptions): Promise<MarkChange[]> {
      const params = new URLSearchParams();
      if (opts?.photoId) params.set('photoId', opts.photoId);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const q = params.toString();
      const res = await request<{ items: MarkChangeDto[] }>(base, `/marks/history${q ? `?${q}` : ''}`);
      return res.items.map(toMarkChange);
    },

    async moveToTrash(ids: string[]): Promise<OpResult> {
      const res = await request<OpResultDto>(base, '/trash', { method: 'POST', body: JSON.stringify({ ids }) });
      return { ok: res.ok, failed: res.failed };
    },

    async restore(ids: string[]): Promise<OpResult> {
      const res = await request<OpResultDto>(base, '/trash/restore', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      return { ok: res.ok, failed: res.failed };
    },

    async listTrash() {
      const res = await request<{ items: TrashEntryDto[] }>(base, '/trash');
      return res.items.map(toTrashEntry);
    },

    async emptyTrash(ids?: string[]): Promise<OpResult> {
      const res = await request<OpResultDto>(base, '/trash?confirm=true', {
        method: 'DELETE',
        body: JSON.stringify({ ids: ids ?? [] }),
      });
      return { ok: res.ok, failed: res.failed };
    },

    async authStatus() {
      const res = await request<{ authRequired?: boolean; authenticated?: boolean }>(base, '/health');
      const required = Boolean(res.authRequired);
      // 旧后端没有 authenticated 字段：免认证时视为已登录，开着认证时保守视为未登录
      const authed = res.authenticated ?? !required;
      return { required, authed };
    },

    async login(password: string) {
      // 不走 request()：那里的 401 会被换成 AuthRequiredError（"需要登录"），
      // 而这里要的是服务端说的真原因（"密码不对"），否则用户看不出密码错在哪。
      const res = await fetch(`${base}/session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 204 || res.ok) return;
      let message = res.status === 401 ? '密码不对' : `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        /* 非 JSON 错误体，保留默认文案 */
      }
      throw new Error(message);
    },

    async logout() {
      try {
        await request<void>(base, '/session', { method: 'DELETE' });
      } catch {
        /* 后端没开认证时 DELETE /session 也可能返回 401/404：登出不该因此报错 */
      }
    },
  };
}
