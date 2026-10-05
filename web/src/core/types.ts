/**
 * 领域模型（前端内部）：与后端契约解耦，只表达「前端需要知道的东西」。
 * 线格式（DTO）在 api/contract.ts，转换在 api/source 实现里完成。
 */

export type PhotoKind = 'photo' | 'video';

/** 预览来源：用于排查「为什么这张图慢 / 糊 / 是内嵌小图」 */
export type PreviewSource = 'external_jpeg' | 'embedded_jpeg' | 'raw_decode' | 'pending';

/** 可选的模糊/跑焦提示（未来服务端分析；mock 会造这几种） */
export type FocusHint = 'sharp' | 'soft' | 'miss' | null;

/** 打标：星级与待删互斥（打星取消待删，待删清星） */
export interface Mark {
  stars: number; // 0..5
  del: boolean;
}

export const NO_MARK: Mark = { stars: 0, del: false };

/**
 * 照片实体 = 配对后的一等实体。
 * RAW+JPEG 双出时，两者属于同一个 Photo（见后端模块 scan）。
 */
export interface Photo {
  id: string;
  dir: string;
  displayName: string;
  kind: PhotoKind;
  /** 宽高比 w/h —— 布局占位靠它，避免加载时跳动 */
  ar: number;
  width?: number;
  height?: number;
  camera?: string | null;
  lens?: string | null;
  hasRaw: boolean;
  hasJpeg: boolean;
  rawPath?: string | null;
  jpegPath?: string | null;
  capturedAt?: string | null;
  mtime: string;
  sizeBytes?: number;
  preview?: PreviewSource;
  focusHint?: FocusHint;
  mark: Mark;
}

export interface Folder {
  name: string;
  path: string;
  photoCount?: number;
  hasSubfolders?: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: Folder[];
  photoCount: number;
}

export interface MarkInput {
  id: string;
  stars?: number;
  del?: boolean;
}

export interface MarkResult {
  id: string;
  ok: boolean;
  error?: string | null;
}

export interface OpFailure {
  id: string;
  error: string;
}

export interface OpResult {
  ok: number;
  failed: OpFailure[];
}

/** 应用模式：a = 逐张挑片（卡片流），c = 批量扫射（网格） */
export type ViewMode = 'a' | 'c';

/** 侧边栏里可去的页面 */
export type View = 'cull' | 'trash' | 'settings';

/** 一个照片根目录：磁盘上的入口。可以有多个（机身卡、移动硬盘、NAS） */
export interface Root {
  id: string;
  path: string;
  label: string;
  photoCount?: number;
  /** 盘没插上时 false —— 侧边栏要看得见但不可点 */
  online: boolean;
}

/** 回收站条目：以配对为单位（RAW+JPEG 一起进、一起出） */
export interface TrashEntry {
  photoId: string;
  displayName: string;
  /** 现在在哪（产品回收站目录） */
  dir: string;
  /** 原来在哪（还原回这里） */
  fromDir: string;
  trashedAt: string;
  kind: PhotoKind;
  ar: number;
  stars: number;
  hasRaw: boolean;
  hasJpeg: boolean;
  sizeBytes?: number;
}

