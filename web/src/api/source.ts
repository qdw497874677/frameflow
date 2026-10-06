import type {
  FolderListing,
  MarkChange,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  Selection,
  TrashEntry,
} from '../core/types';

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
  /** 有哪些根目录可管 */
  listRoots(): Promise<Root[]>;
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
