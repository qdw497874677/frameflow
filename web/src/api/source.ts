import type {
  Channel,
  FolderListing,
  InboundItem,
  Job,
  JobEvent,
  JobState,
  MarkChange,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  Selection,
  TrashEntry,
} from '../core/types';
import type { FsBrowseDto } from './contract';

export interface ListPhotosOptions {
  dir: string;
  /**
   * 选择集（谓词）。省略 = 该目录的全部照片。
   * 以前这里是一个枚举 filter（all/starred/trash/unmarked）—— 枚举长不大，
   * 换个条件就要改端口；谓词可以直接进 URL、存进任务里。
   */
  selection?: Selection;
  cursor?: string;
  limit?: number;
  /** 含子目录：把 dir 下面所有层级的照片都列出来（项目级挑片）；省略 = 只看直属照片 */
  recursive?: boolean;
}

export interface MarkHistoryOptions {
  /** 只要这一张的变更 */
  photoId?: string;
  limit?: number;
}

export interface PhotoPage {
  items: Photo[];
  nextCursor?: string | null;
  total?: number;
}

/**
 * 后端说要登录（HTTP 401）。界面据此弹登录页，而不是把人扔进一个空舞台。
 * 单独一个类型而不是普通 Error：调用方要能区分「没登录」与「出错」。
 */
export class AuthRequiredError extends Error {
  constructor(message = '需要登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * 数据访问端口（port）。UI 只依赖这个接口：
 *  - httpSource：真实后端（contracts/openapi.yaml）
 *  - mockSource：浏览器内假数据（无需后端即可开发交互）
 * 换实现不改 UI —— 这是前后端模块分离在前端一侧的落点。
 */
export interface PhotoSource {
  readonly kind: 'mock' | 'http';
  /** 有哪些项目可管 */
  listRoots(): Promise<Root[]>;
  /** 添加一个项目（设置页「添加项目」）：后端探路径可达后入列并后台扫描，重启不丢 */
  addRoot(input: { path: string; label?: string }): Promise<Root>;
  /** 改显示名：只动配置里的 label，id/路径/照片都不动 */
  renameRoot(id: string, label: string): Promise<Root>;
  /** 移除根：只解除映射，盘上文件一个不动；重新添加同名路径即找回 */
  removeRoot(id: string): Promise<void>;
  /** 「选择目录」下钻：列磁盘目录（后端在用户机器上，能看真实文件系统）；缺省主目录 */
  browseFs(path?: string): Promise<FsBrowseDto>;
  listFolders(path?: string): Promise<FolderListing>;
  listPhotos(opts: ListPhotosOptions): Promise<PhotoPage>;
  /** 缩略图 URL：mock 返回 data URL；http 返回后端 URL */
  thumbUrl(photoId: string, size: 512 | 2048): string;
  saveMarks(items: MarkInput[]): Promise<MarkResult[]>;
  /** 标注变更日志（最新的在前）：谁、什么时候、把哪个字段从什么改成了什么 */
  listMarkHistory(opts?: MarkHistoryOptions): Promise<MarkChange[]>;
  moveToTrash(ids: string[]): Promise<OpResult>;
  restore(ids: string[]): Promise<OpResult>;
  /** 回收站里现在有什么 */
  listTrash(): Promise<TrashEntry[]>;
  /** 真删：传 ids 只删这些，不传 = 清空；后端会带 confirm 参数 */
  emptyTrash(ids?: string[]): Promise<OpResult>;
  /** 登录状态（`/health`）：后端要不要密码 + 这次请求有没有带有效凭据；mock 恒 `{required:false, authed:true}` */
  authStatus(): Promise<{ required: boolean; authed: boolean }>;
  /** 密码换会话 cookie（单用户）；密码不对时抛错 */
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

/* ── 任务（动作层）端口 ─────────────────────────────────────────────── */

export interface JobCreateInput {
  kind: string;
  selection: Selection;
  params?: Record<string, unknown>;
  /** plan = 只预演（把选择集展开成 items 给你看，不落库）；apply = 真建。缺省 plan */
  mode?: 'plan' | 'apply';
}

export interface ListJobsOptions {
  state?: JobState;
  limit?: number;
}

export interface JobEventPage {
  items: JobEvent[];
  nextSince: number;
}

/**
 * 任务端口：与 PhotoSource 分开 —— ADR 0004 说 PhotoSource 将来要拆成
 * LibrarySource（读库 / 改标注 / 回收站）与 JobSource（派发与追踪）。
 * 先拆出任务这一半：状态层和动作层是两种东西，凑在一个接口里会让 UI 以为
 * 「派发批注」和「点一颗星」是同一类操作。
 */
export interface JobSource {
  readonly kind: 'mock' | 'http';
  /** 建任务：服务端把选择集展开成 items 快照（那一批就是这些），返回任务 */
  createJob(input: JobCreateInput): Promise<Job>;
  /** 便利写法 = createJob({ ...input, mode: 'plan' })：先预演给人看，再 apply */
  planJob(input: JobCreateInput): Promise<Job>;
  /** 任务列表（最新的在前） */
  listJobs(opts?: ListJobsOptions): Promise<Job[]>;
  getJob(id: string): Promise<Job>;
  /**
   * 增量事件：`since` 传上次拿到的 `nextSince`。
   * v1 是轮询（单用户单进程，任务页只看进度与「谁改了什么」）；
   * 形状与将来的 SSE 一致 —— 换传输不改调用方。
   */
  jobEvents(id: string, opts?: { since?: number; limit?: number }): Promise<JobEventPage>;
  cancelJob(id: string): Promise<Job>;
  /** 撤销：只有 handler 声明 reversible 的任务才能撤销，否则抛错 */
  undoJob(id: string): Promise<Job>;
  /** 已配置的**出站**通道（回流不走通道，走 POST /jobs/{id}/inbound） */
  listChannels(): Promise<Channel[]>;
}

/* ── 批注页端口（外部批注人，手里只有一条 ?t= 范围 token）──────────────── */

/**
 * 批注页的数据口：外部批注人没有会话、没有 Bearer，只有任务签发的那条链接。
 * 单独一个端口而不是塞进 JobSource —— JobSource 是「本人派发与追踪任务」的全面，
 * 这里是「别人拿着链接来标注」的窄面：能做的事就三件（读自己那个任务、看它的缩略图、回写）。
 */
export interface AnnotateSource {
  readonly kind: 'mock' | 'http';
  /** 用范围 token 读它自己那个任务（服务端只放行 token 里绑定的那个 id） */
  getJobForAnnotator(token: string, jobId: string): Promise<Job>;
  /** 本任务 items 的缩略图：URL 自带凭据（图像标签带不上自定义 header） */
  thumbUrlForAnnotator(photoId: string, token: string, size: 512 | 2048): string;
  /** 回流：`by` 由服务端从 token 里的批注人推；返回逐项结果（重复 clientRef 会返回首次结果） */
  submitInbound(token: string, jobId: string, items: InboundItem[]): Promise<MarkResult[]>;
}
