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
  /** 直属、不含待删的照片数 */
  photoCount: number;
  /** 直属的待删照片数（老服务端没有这个字段） */
  deletedCount?: number;
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
  /** 'me' | 'link:<批注人>' | 'ai' | 'job:<id>' */
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
export type View = 'cull' | 'trash' | 'jobs' | 'settings';

/** 一个项目 = 映射进来的一个目录：磁盘上的入口，可以有多个（机身卡、移动硬盘、NAS） */
export interface Root {
  id: string;
  path: string;
  /** 磁盘绝对路径 —— 侧边栏直接展示，让用户知道这次导的是哪个目录 */
  diskPath?: string;
  label: string;
  photoCount?: number;
  /** 盘没插上时 false —— 侧边栏要看得见但不可点 */
  online: boolean;
  /** 上一次访问失败的原因（扫描超时、挂载没挂上）；正常时为 null */
  lastError?: string | null;
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

/* ── 任务（动作层）：状态层之外的「有进度、有产物、可撤销」的事 ─────────
 * 扫描/浏览/标记是状态（同步、即时落盘）；派发批注、导出、批处理是动作 ——
 * 它们要么长跑、要么要派人、要么产出文件，所以要能被追踪、取消、撤销。
 * 一个任务 = 选择集（怎么选出来的）+ kind（干什么）+ 参数 + 展开好的 items 快照。
 */

export type JobState =
  | 'planned'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** manifest 的一行：「这个单位被怎么处理了」；粒度是照片配对组（RAW+JPEG 一起走） */
export interface JobItem {
  id: string;
  displayName?: string;
  status: 'planned' | 'done' | 'skipped' | 'failed';
  from?: string;
  to?: string;
  note?: string;
  /** annotate：外部/执行者给的最终星数 */
  stars?: number | null;
  del?: boolean | null;
  clientRef?: string | null;
  at?: string | null;
  /** grade（滤镜设置阶段）：这张的覆盖与过目时刻；缺省字段跟任务默认 */
  grade?: { look?: string | null; strength?: number; reviewedAt?: string | null } | null;
  /** grade：只有 RAW 时像素用机内内嵌 JPEG */
  source?: 'embedded_jpeg' | null;
}

/** 内置胶片风格（GET /looks） */
export interface Look {
  id: string;
  name: string;
  inspiredBy?: string;
  /** cube = 内置 .cube；film = 光谱胶片引擎（可加导出时的颗粒 / 光晕） */
  kind?: 'cube' | 'film';
}

/** 胶片整帧效果（grade 任务 params.film）：只对 film 风格、只在导出生效 */
export interface FilmEffects {
  grain?: number;
  grainSeed?: number;
  halation?: number;
  halationRadiusMm?: number;
  dirDiffusionUm?: number;
  filmFormatMm?: number;
}

/** 批注回流的一项：批注页给某一张的最终结论（`by` 不在里面 —— 由服务端从链接里的批注人推） */
export interface InboundItem {
  photoId: string;
  stars?: number;
  del?: boolean;
  at?: string;
  /** 幂等键：同一项重发（断网重试）不会重复落标 */
  clientRef?: string;
}

/** 任务的产物：批注任务是卡片/链接，导出是目录/文件 */
export interface Artifact {
  kind: 'file' | 'dir' | 'url' | 'message';
  path: string;
  bytes?: number;
}

export type JobEventType =
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

/** 任务事件日志的一行：追加型、不回改，`seq` 单调递增（轮询游标，将来当 SSE 的 Last-Event-ID） */
export interface JobEvent {
  seq: number;
  at: string;
  type: JobEventType;
  photoId?: string | null;
  from?: number | boolean | string | null;
  to?: number | boolean | string | null;
  /** me | link:<批注人> | ai:<模型> | job:<id> */
  by?: string | null;
  channel?: string | null;
  clientRef?: string | null;
  note?: string | null;
}

export interface Job {
  id: string;
  /** 能力名：annotate | export | process | … */
  kind: string;
  state: JobState;
  selection: Selection;
  params?: Record<string, unknown>;
  channel?: string | null;
  dispatchedAt?: string | null;
  /** 数的是 items；total 在创建展开时就定了 */
  progress: { done: number; total: number };
  /** 创建时展开的快照 —— 派发出去的那一批必须是稳定的 */
  items: JobItem[];
  artifacts: Artifact[];
  error?: string | null;
  reversible: boolean;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** F27：显式确认任务（飞书等外部目标回流）才有；跳过不算完成 */
  confirmationMode?: 'explicit';
  confirmation?: { confirmed: number; remaining: number; blocked: number; total: number };
  /** 后台阶段：grade 完成后导出中 = 'exporting' */
  phase?: 'exporting' | null;
}

/** 出站投递通道：只管「怎么把一批照片发出去」；回流一律走任务 */
export interface Channel {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
}

