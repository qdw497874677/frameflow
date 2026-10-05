import type {
  ArchivePlanDto,
  ArchiveResultDto,
  FolderListingDto,
  MarkInputDto,
  MarkResultDto,
  OpResultDto,
  PhotoDto,
  PhotoPageDto,
  RootDto,
  RuleDto,
  TrashEntryDto,
} from './contract';
import type { ListPhotosOptions, PhotoPage, PhotoSource, PlanOptions } from './source';
import type {
  ArchivePlan,
  ArchiveResult,
  Folder,
  FolderListing,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  Rule,
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
  return dto;
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

export function toRule(dto: RuleDto): Rule {
  return {
    id: dto.id,
    name: dto.name,
    enabled: dto.enabled !== false,
    match: {
      kind: dto.match?.kind ?? 'any',
      minStars: dto.match?.minStars ?? 0,
      del: dto.match?.del ?? false,
      camera: dto.match?.camera ?? null,
    },
    dest: dto.dest,
    onConflict: dto.onConflict ?? 'rename',
    pair: dto.pair !== false,
  };
}

export function toRuleDto(rule: Rule): RuleDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    match: { ...rule.match },
    dest: rule.dest,
    onConflict: rule.onConflict,
    pair: rule.pair,
  };
}

export function toArchivePlan(dto: ArchivePlanDto): ArchivePlan {
  return {
    id: dto.id,
    dir: dto.dir,
    createdAt: dto.createdAt,
    moves: dto.moves.map((m) => ({
      photoId: m.photoId,
      displayName: m.displayName,
      from: m.from,
      to: m.to,
      kind: m.kind,
      stars: m.stars ?? 0,
      sizeBytes: m.sizeBytes,
      ruleId: m.ruleId,
      ruleName: m.ruleName,
    })),
    skipped: dto.skipped ?? [],
    totalBytes: dto.totalBytes ?? 0,
  };
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
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
      if (opts.filter) params.set('filter', opts.filter);
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

    async listRules() {
      const res = await request<{ rules: RuleDto[] }>(base, '/rules');
      return res.rules.map(toRule);
    },

    async saveRules(rules: Rule[]) {
      const body = JSON.stringify({ rules: rules.map(toRuleDto) });
      const res = await request<{ rules: RuleDto[] }>(base, '/rules', { method: 'PUT', body });
      return res.rules.map(toRule);
    },

    async planArchive(opts: PlanOptions) {
      const body = JSON.stringify(opts);
      return toArchivePlan(await request<ArchivePlanDto>(base, '/archive/plan', { method: 'POST', body }));
    },

    async applyArchive(planId: string): Promise<ArchiveResult> {
      const res = await request<ArchiveResultDto>(base, '/archive/apply', {
        method: 'POST',
        body: JSON.stringify({ planId }),
      });
      return { planId: res.planId, moved: res.moved, failed: res.failed };
    },
  };
}
