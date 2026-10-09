import type {
  ChannelDto,
  FolderListingDto,
  FsBrowseDto,
  JobCreateDto,
  JobDto,
  JobEventPageDto,
  MarkChangeDto,
  MarkInputDto,
  MarkResultDto,
  OpResultDto,
  PhotoDto,
  PhotoPageDto,
  RootDto,
  TrashEntryDto,
} from './contract';
import type {
  AnnotateSource,
  JobCreateInput,
  JobEventPage,
  JobSource,
  ListJobsOptions,
  ListPhotosOptions,
  MarkHistoryOptions,
  PhotoPage,
  PhotoSource,
} from './source';
import { AuthRequiredError } from './source';
import { selectionToQuery } from '../core/selection';
import type {
  Folder,
  FolderListing,
  InboundItem,
  Job,
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
    diskPath: dto.diskPath ?? undefined,
    label: dto.label || dto.path,
    photoCount: dto.photoCount,
    online: dto.online !== false,
    lastError: dto.lastError ?? null,
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

    async addRoot(input: { path: string; label?: string }) {
      const res = await request<{ root: RootDto }>(base, '/roots', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return toRoot(res.root);
    },

    async renameRoot(id: string, label: string) {
      const res = await request<{ root: RootDto }>(base, `/roots/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      });
      return toRoot(res.root);
    },

    async removeRoot(id: string) {
      await request<void>(base, `/roots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async browseFs(path?: string) {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      return request<FsBrowseDto>(base, `/fs/browse${qs}`);
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
      if (opts.recursive) params.set('recursive', '1');
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

/* ── 任务端口（/jobs）─────────────────────────────────────────────────
 * 与 PhotoSource 分开实现：状态层（读库/标记）和动作层（派发/导出）是两种东西。
 */

/** DTO → 领域：items / events 形状一一对应（直接浅拷）；progress 缺省按 items 数补 */
function toJob(dto: JobDto): Job {
  const items = (dto.items ?? []).map((i) => ({ ...i }));
  return {
    ...dto,
    params: dto.params ?? {},
    channel: dto.channel ?? null,
    dispatchedAt: dto.dispatchedAt ?? null,
    progress: { done: dto.progress?.done ?? 0, total: dto.progress?.total ?? items.length },
    items,
    artifacts: (dto.artifacts ?? []).map((a) => ({ ...a })),
    error: dto.error ?? null,
    reversible: Boolean(dto.reversible),
    startedAt: dto.startedAt ?? null,
    finishedAt: dto.finishedAt ?? null,
  };
}

export function createHttpJobSource(base = '/api/v1'): JobSource {
  const post = <T>(path: string, payload?: unknown) =>
    request<T>(base, path, {
      method: 'POST',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return {
    kind: 'http',

    async createJob(input: JobCreateInput): Promise<Job> {
      return toJob(await post<JobDto>('/jobs', input));
    },

    async planJob(input: JobCreateInput): Promise<Job> {
      // 只读预演：服务端把选择集展开成 items 但不落库（人看过再 apply）
      const payload: JobCreateDto = { ...input, mode: 'plan' };
      return toJob(await post<JobDto>('/jobs', payload));
    },

    async listJobs(opts?: ListJobsOptions): Promise<Job[]> {
      const params = new URLSearchParams();
      if (opts?.state) params.set('state', opts.state);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const q = params.toString();
      const res = await request<{ items: JobDto[] }>(base, `/jobs${q ? `?${q}` : ''}`);
      return res.items.map(toJob);
    },

    async getJob(id: string): Promise<Job> {
      return toJob(await request<JobDto>(base, `/jobs/${encodeURIComponent(id)}`));
    },

    async jobEvents(id: string, opts?: { since?: number; limit?: number }): Promise<JobEventPage> {
      const params = new URLSearchParams();
      if (opts?.since) params.set('since', String(opts.since));
      if (opts?.limit) params.set('limit', String(opts.limit));
      const q = params.toString();
      const res = await request<JobEventPageDto>(
        base,
        `/jobs/${encodeURIComponent(id)}/events${q ? `?${q}` : ''}`,
      );
      return { items: res.items.map((e) => ({ ...e })), nextSince: res.nextSince };
    },

    async cancelJob(id: string): Promise<Job> {
      return toJob(await post<JobDto>(`/jobs/${encodeURIComponent(id)}/cancel`));
    },

    async undoJob(id: string): Promise<Job> {
      return toJob(await post<JobDto>(`/jobs/${encodeURIComponent(id)}/undo`));
    },

    async listChannels() {
      const res = await request<{ items: ChannelDto[] }>(base, '/channels');
      return res.items.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        enabled: c.enabled ?? true,
      }));
    },
  };
}

/* ── 批注页端口（/j?t=）───────────────────────────────────────────────
 * 外部批注人只有一条范围 token：所有请求都把凭据放在 `?t=` 上（图像标签带不上 header）。
 * 服务端只放行三件事：读它自己那个任务、读本任务 items 的缩略图、POST 回流。
 */
export function createHttpAnnotateSource(base = '/api/v1'): AnnotateSource {
  const withToken = (path: string, token: string) =>
    `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;

  return {
    kind: 'http',

    async getJobForAnnotator(token: string, jobId: string): Promise<Job> {
      return toJob(await request<JobDto>(base, withToken(`/jobs/${encodeURIComponent(jobId)}`, token)));
    },

    thumbUrlForAnnotator(photoId: string, token: string, size: 512 | 2048): string {
      return `${base}${withToken(`/photos/${encodeURIComponent(photoId)}/thumb?size=${size}`, token)}`;
    },

    async submitInbound(token: string, jobId: string, items: InboundItem[]): Promise<MarkResult[]> {
      const res = await request<{ results: MarkResultDto[] }>(
        base,
        withToken(`/jobs/${encodeURIComponent(jobId)}/inbound`, token),
        { method: 'POST', body: JSON.stringify({ items }) },
      );
      return res.results.map((r) => ({ id: r.id, ok: r.ok, error: r.error ?? null }));
    },
  };
}
