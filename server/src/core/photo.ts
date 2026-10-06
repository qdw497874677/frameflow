/**
 * 服务端领域模型（内部记录）。
 *
 * 与 `contracts/openapi.yaml` 的 Photo/Root 对应，但**不是**线格式：
 * 线格式的组装在 `core/dto.ts`，绝对路径永远不出这个目录。
 */

export type PhotoKind = 'photo' | 'video';

/** 预览来源，排查用（票 001 的分层管线） */
export type PreviewSource = 'external_jpeg' | 'embedded_jpeg' | 'raw_decode' | 'pending';

export type FocusHint = 'sharp' | 'soft' | 'miss';

export interface FileRef {
  /** 绝对路径（只在本进程内使用） */
  path: string;
  mtimeMs: number;
  size: number;
}

export interface FileMeta {
  width?: number;
  height?: number;
  orientation?: number;
  camera?: string | null;
  lens?: string | null;
  capturedAt?: string | null;
}

/**
 * 一个「照片实体」= 同目录同名的 RAW/ JPEG（可能还有影子文件）配对后的结果。
 * 配对规则见票 001：同目录 + 大小写不敏感同名 + 扩展名分类；多 RAW 取扩展名字母序最早。
 */
export interface PhotoRecord {
  id: string;
  rootId: string;
  /** 相对根目录的目录，POSIX，无前后斜杠；根目录自身为 '' */
  relDir: string;
  /** 相对根目录的无扩展名路径（配对键） */
  relStem: string;
  /** 显示名 = 主文件名去扩展名 */
  displayName: string;
  kind: PhotoKind;
  raw?: FileRef & { ext: string };
  jpeg?: FileRef & { ext: string };
  /** 生成预览时优先读的文件（外部 JPEG 优先，否则 RAW） */
  previewPath: string;
  previewSource: PreviewSource;
  meta: FileMeta;
  stars: number;
  del: boolean;
  focusHint: FocusHint | null;
}
