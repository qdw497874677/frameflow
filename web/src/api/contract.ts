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
  videoPath?: string | null;
  sizeBytes?: number;
  mtime: string;
  stars: number;
  del: boolean;
  preview?: 'external_jpeg' | 'embedded_jpeg' | 'video_poster' | 'raw_decode' | 'pending';
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
  /** 客户端时刻（ISO）：服务端以它为准写变更日志，缺省用服务端时间 */
  at?: string;
  /** 谁改的：'me' | 'link:<别名>' | 'ai' | 'job:<id>' */
  by?: string;
  /** 从哪个渠道改的：'inapp' | 'feishu' | … */
  channel?: string;
}

/** 标注变更事件：POST 之外只读（追加入日志，不回改） */
export interface MarkChangeDto {
  photoId: string;
  displayName?: string;
  field: 'stars' | 'del';
  from: number | boolean | null;
  to: number | boolean | null;
  by: string;
  channel: string;
  at: string;
  jobId?: string | null;
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

