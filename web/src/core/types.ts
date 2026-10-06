/**
 * 领域模型（前端内部）：与后端契约解耦，只表达「前端需要知道的东西」。
 * 线格式（DTO）在 api/contract.ts，转换在 api/source 实现里完成。
 */

export type PhotoKind = 'photo' | 'video';

/** 预览来源：用于排查「为什么这张图慢 / 糊 / 是内嵌小图」 */
export type PreviewSource = 'external_jpeg' | 'embedded_jpeg' | 'video_poster' | 'raw_decode' | 'pending';

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
  /** 客户端记下的时刻（ISO）；服务端写变更日志时用它，缺省用服务端时间 */
  at?: string;
  by?: string;
  channel?: string;
}

/** 谁改的、从哪改的：外部批注回流的凭据 */
export interface MarkActor {
  /** 'me' | 'link:<别名>' | 'ai' | 'job:<id>' */
  by: string;
  /** 'inapp' | 'feishu' | … */
  channel: string;
}

/** 本人、在应用里改的 —— 目前唯一的来源 */
export const ME: MarkActor = { by: 'me', channel: 'inapp' };

/**
 * 标注变更事件：追加进变更日志（后端落 marks.jsonl），XMP / 库文件只留最终状态。
 * 没有它，「飞书里同事点的星」和本地改的就没法合并。
 */
export interface MarkChange {
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

/**
 * 选择集：可序列化的谓词，**不是 id 清单**。
 * 任务是「选择集 + 操作 + 参数」—— 所以它要能存盘、能进 URL、能发给后端。
 * 语法规范（对象形式与紧凑字符串形式的对应）见 contracts/selection.md。
 */
export interface Selection {
  /** 项目（映射的目录）；省略 = 当前项目的目录 */
  project?: string;
  /** 谓词：字段之间 AND */
  where?: {
    kind?: PhotoKind;
    stars?: { gte?: number; lte?: number; eq?: number };
    del?: boolean;
    /** 是否打过星（stars > 0） */
    marked?: boolean;
    /** 目录包含匹配（大小写不敏感） */
    folder?: string;
    camera?: string;
    /** 拍摄日：闭区间，YYYY-MM-DD */
    taken?: { after?: string; before?: string };
  };
  /** 手选清单（UI 里点出来的）；与 where 同时存在时取交集 */
  ids?: string[];
}

export const EMPTY_SELECTION: Selection = {};

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

