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
export type View = 'cull' | 'trash' | 'archive' | 'rules' | 'settings';

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

/** 星级条件：写数字 = ≥n；写对象是区间 */
export type RuleStars = number | { gte?: number; lte?: number; eq?: number };

/** 规则匹配条件：不填 = 不限。不同条件是 AND；同一条件写数组是 OR */
export interface RuleMatch {
  kind?: 'any' | PhotoKind | Array<'any' | PhotoKind>;
  stars?: RuleStars;
  /** 是否打过星（含 1–5 星） */
  marked?: boolean;
  camera?: string | string[];
  lens?: string | string[];
  taken?: { after?: string; before?: string; lastDays?: number };
  /** 当前目录的 glob */
  folder?: string;
}

/** 规则命中后干什么。v1 只有移动与跳过（没有 copy） */
export type RuleAction = 'move' | 'skip';

/** 归档规则：先把「匹配什么」和「放到哪」说清楚，规则编辑 UI 见 wayfinder 票 007 */
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** 只处理匹配这些 glob 的目录 */
  onlyFrom?: string[];
  match: RuleMatch;
  action: RuleAction;
  /** 目标模板，变量见 contracts/rules.md：{root} {project} {device} {kind} {variant} {date:FORMAT} {folder:N} … */
  dest: string;
  onConflict: 'rename' | 'skip';
  /** true = 主文件与影子文件（.xmp/.aae…）成组原子地一起搬 */
  pair: boolean;
}

/** 预演里的一条移动 */
export interface ArchiveMove {
  photoId: string;
  displayName: string;
  from: string;
  to: string;
  kind: PhotoKind;
  stars: number;
  sizeBytes?: number;
  ruleId: string;
  ruleName: string;
}

/** 归档预演：先看清楚要搬什么、搬去哪，再动手 */
export interface ArchivePlan {
  id: string;
  dir: string;
  createdAt: string;
  moves: ArchiveMove[];
  skipped: { photoId: string; displayName: string; reason: string }[];
  totalBytes: number;
}

export interface ArchiveResult {
  planId: string;
  moved: number;
  failed: OpFailure[];
}
