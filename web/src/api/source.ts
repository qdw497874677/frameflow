import type {
  FolderListing,
  MarkInput,
  MarkResult,
  OpResult,
  Photo,
  Root,
  TrashEntry,
} from '../core/types';

export interface ListPhotosOptions {
  dir: string;
  filter?: 'all' | 'starred' | 'trash' | 'unmarked';
  cursor?: string;
  limit?: number;
}

export interface PhotoPage {
  items: Photo[];
  nextCursor?: string | null;
  total?: number;
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
  moveToTrash(ids: string[]): Promise<OpResult>;
  restore(ids: string[]): Promise<OpResult>;
  /** 回收站里现在有什么 */
  listTrash(): Promise<TrashEntry[]>;
  /** 真删：传 ids 只删这些，不传 = 清空；后端会带 confirm 参数 */
  emptyTrash(ids?: string[]): Promise<OpResult>;
}
