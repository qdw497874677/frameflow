/**
 * 线格式（wire DTO）：与 contracts/openapi.yaml 一一对应。
 * 只在前端与后端之间传输时使用；UI 只接触 core/types.ts 的领域模型。
 */

export interface HealthDto {
  ok: boolean;
  version: string;
  roots: string[];
}

export interface FolderDto {
  name: string;
  path: string;
  photoCount?: number;
  hasSubfolders?: boolean;
}

export interface FolderListingDto {
  path: string;
  parent: string | null;
  folders: FolderDto[];
  photoCount: number;
}

export interface PhotoDto {
  id: string;
  dir: string;
  displayName: string;
  kind: 'photo' | 'video';
  ar: number;
  width?: number;
  height?: number;
  orientation?: number;
  capturedAt?: string | null;
  camera?: string | null;
  lens?: string | null;
  hasRaw?: boolean;
  hasJpeg?: boolean;
  rawPath?: string | null;
  jpegPath?: string | null;
  sizeBytes?: number;
  mtime: string;
  stars: number;
  del: boolean;
  preview?: 'external_jpeg' | 'embedded_jpeg' | 'raw_decode' | 'pending';
  focusHint?: 'sharp' | 'soft' | 'miss' | null;
}

export interface PhotoPageDto {
  items: PhotoDto[];
  nextCursor?: string | null;
  total?: number;
}

export interface MarkInputDto {
  id: string;
  stars?: number;
  del?: boolean;
}

export interface MarkResultDto {
  id: string;
  ok: boolean;
  stars?: number;
  del?: boolean;
  error?: string | null;
}

export interface OpResultDto {
  ok: number;
  failed: { id: string; error: string }[];
}

export interface ErrorDto {
  error: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/* ── 根目录 / 回收站 / 规则 / 归档 ────────────────────── */

export interface RootDto {
  id: string;
  path: string;
  label: string;
  photoCount?: number;
  online?: boolean;
}

export interface TrashEntryDto {
  photoId: string;
  displayName: string;
  dir: string;
  fromDir: string;
  trashedAt: string;
  kind: 'photo' | 'video';
  ar: number;
  stars?: number;
  hasRaw?: boolean;
  hasJpeg?: boolean;
  sizeBytes?: number;
}

export interface RuleDto {
  id: string;
  name: string;
  enabled?: boolean;
  match?: {
    kind?: 'any' | 'photo' | 'video';
    minStars?: number;
    del?: boolean;
    camera?: string | null;
  };
  dest: string;
  onConflict?: 'rename' | 'skip';
  pair?: boolean;
}

export interface ArchiveMoveDto {
  photoId: string;
  displayName: string;
  from: string;
  to: string;
  kind: 'photo' | 'video';
  stars?: number;
  sizeBytes?: number;
  ruleId: string;
  ruleName: string;
}

export interface ArchivePlanDto {
  id: string;
  dir: string;
  createdAt: string;
  moves: ArchiveMoveDto[];
  skipped?: { photoId: string; displayName: string; reason: string }[];
  totalBytes?: number;
}

export interface ArchiveResultDto {
  planId: string;
  moved: number;
  failed: { id: string; error: string }[];
}
