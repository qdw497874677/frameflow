/**
 * 线格式（wire DTO）：与 contracts/openapi.yaml 一一对应。
 * 只在前端与后端之间传输时使用；UI 只接触 core/types.ts 的领域模型。
 *
 * 例外：`Selection` 直接从领域模型复用 —— 它不是「传输时才有的形状」，
 * 而是前后端共用的谓词语法（对象形式与紧凑串的对应见 contracts/selection.md）。
 */

import type { Selection } from '../core/types';

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
  /** 谁改的：'me' | 'link:<批注人>' | 'ai' | 'job:<id>' */
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

/* ── 项目（root）/ 回收站 / 规则 / 归档 ───────────────── */

export interface RootDto {
  id: string;
  path: string;
  diskPath?: string;
  label: string;
  photoCount?: number;
  online?: boolean;
  lastError?: string | null;
}

/** POST /roots 的入参（设置页「添加项目」） */
export interface RootInputDto {
  path: string;
  label?: string;
}

/** GET /fs/browse 的返回（「选择目录」下钻数据源，只列目录） */
export interface FsBrowseDto {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
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

/* ── 任务（/jobs）：动作层的线格式 ─────────────────────
 * 状态层（扫描/浏览/标记）同步即时落盘；动作层（派发批注/导出/处理）长跑、
 * 有进度、有产物、可撤销 —— 所以它是任务。形状见 docs/core-model.md §5–§7。
 */

export type JobStateDto =
  | 'planned'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** manifest 的一行：「这个单位被怎么处理了」；对 annotate 就是「这张被标成了什么」 */
export interface JobItemDto {
  id: string;
  displayName?: string;
  status: 'planned' | 'done' | 'skipped' | 'failed';
  from?: string;
  to?: string;
  note?: string;
  stars?: number | null;
  del?: boolean | null;
  /** 回流幂等键（外部系统重发整批时用来去重） */
  clientRef?: string | null;
  at?: string | null;
}

export type JobEventTypeDto =
  | 'created'
  | 'dispatched'
  | 'inbound'
  | 'applied'
  | 'skipped'
  | 'conflict'
  | 'failed'
  | 'cancelled'
  | 'undone'
  | 'done'
  | 'note';

/** 任务事件日志的一行（追加型，不回改）；`seq` 单调递增，可当轮询游标 */
export interface JobEventDto {
  seq: number;
  at: string;
  type: JobEventTypeDto;
  photoId?: string | null;
  /** 改前 / 改后：stars 整数、del 布尔、或状态字符串 */
  from?: number | boolean | string | null;
  to?: number | boolean | string | null;
  by?: string | null;
  channel?: string | null;
  clientRef?: string | null;
  note?: string | null;
}

/** 任务的产物：批注任务是卡片/链接，导出是目录/文件 */
export interface ArtifactDto {
  kind: 'file' | 'dir' | 'url' | 'message';
  path: string;
  bytes?: number;
}

export interface JobDto {
  id: string;
  /** 能力名：annotate | export | process | …（一个 kind 一个 handler） */
  kind: string;
  state: JobStateDto;
  selection: Selection;
  /** handler 参数；annotate：{ channel, label } */
  params?: Record<string, unknown>;
  channel?: string | null;
  dispatchedAt?: string | null;
  progress?: { done?: number; total?: number };
  items?: JobItemDto[];
  artifacts?: ArtifactDto[];
  error?: string | null;
  reversible?: boolean;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** POST /jobs 的入参：plan 只读预演（展开 items 不落库），apply 真干 */
export interface JobCreateDto {
  kind: string;
  selection: Selection;
  params?: Record<string, unknown>;
  mode?: 'plan' | 'apply';
}

export interface JobEventPageDto {
  items: JobEventDto[];
  nextSince: number;
}

/** 批注回流的一项（`POST /jobs/{id}/inbound`）：`by` 由服务端从 token 里的批注人推，请求体里没有这个字段 */
export interface InboundItemDto {
  photoId: string;
  stars?: number;
  del?: boolean;
  at?: string;
  clientRef?: string;
}

/** 出站投递通道（应用内 / 飞书 / webhook…）；回流不走通道，走 `POST /jobs/{id}/inbound` */
export interface ChannelDto {
  id: string;
  kind: string;
  label: string;
  enabled?: boolean;
}

// ── 连接器管理（/connectors，仅管理 session）──────────────────────────────

export interface ConnectorTargetDto {
  id: string;
  connectorId: string;
  label: string;
  kind: 'group' | 'user';
  externalId: string;
  projectIds: string[];
  allowedActorIds: string[];
  canAnnotate: boolean;
  canRequestJpeg: boolean;
}

export interface ConnectorInstanceInputDto {
  id: string;
  kind: 'feishu';
  label: string;
  appId: string;
  /** 环境变量名，不是 Secret 本身 */
  secretEnv: string;
  tenantId: string | null;
  enabled?: false;
  targets: ConnectorTargetDto[];
  creatorActorIds: string[];
  creatorProjectIds: string[];
}

export interface ConnectorStatusDto {
  state: 'disabled' | 'connecting' | 'connected' | 'degraded' | 'error';
  reason?: string;
  lastConnectedAt?: string;
}

export interface ConnectorDto extends Omit<ConnectorInstanceInputDto, 'enabled'> {
  enabled: boolean;
  secretConfigured: boolean;
  status: ConnectorStatusDto;
}

export interface ConnectorPageDto {
  revision: number;
  items: ConnectorDto[];
  nextCursor: string | null;
}

export interface ConnectorMutationDto {
  revision: number;
  item: ConnectorDto;
}

export interface ConnectorVerifyResultDto {
  ok: boolean;
  code?: string;
}
