/**
 * 线格式 DTO：与 `contracts/openapi.yaml` 的 schemas 一一对应。
 * 前端 `web/src/api/contract.ts` 是同一份定义的另一半 —— 改动必须两边一起动。
 */

import type { PhotoRecord, FocusHint, PreviewSource } from './photo.ts';
import { basename } from 'node:path';
import { dirPath, virtualFilePath } from './ids.ts';
import type { TrashRecord } from './trash.ts';

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
  preview?: PreviewSource;
  focusHint?: FocusHint | null;
}

export interface RootDto {
  id: string;
  path: string;
  label: string;
  photoCount?: number;
  online?: boolean;
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

export interface OpFailureDto {
  id: string;
  error: string;
}

/** 「做了 N 件、这几件没做成」的统一回执（移动/回收站/归档都用它） */
export interface OpResultDto {
  ok: number;
  failed: OpFailureDto[];
}

/** 回收站里的一条：现在在哪、原来在哪（契约 TrashEntry） */
export interface TrashEntryDto {
  photoId: string;
  displayName: string;
  dir: string;
  fromDir: string;
  trashedAt: string;
  kind?: 'photo' | 'video';
  ar?: number;
  stars?: number;
  hasRaw?: boolean;
  hasJpeg?: boolean;
  sizeBytes?: number;
}

export function toTrashEntryDto(rec: TrashRecord, ar?: number): TrashEntryDto {
  return {
    photoId: rec.photoId,
    displayName: rec.displayName,
    dir: rec.dir,
    fromDir: rec.fromDir,
    trashedAt: rec.trashedAt,
    kind: rec.kind,
    ar,
    stars: rec.stars,
    hasRaw: rec.hasRaw,
    hasJpeg: rec.hasJpeg,
    sizeBytes: rec.sizeBytes,
  };
}

export function toPhotoDto(rec: PhotoRecord): PhotoDto {
  const dir = dirPath(rec.rootId, rec.relDir);
  // 朝向 5–8 表示「传感器是横的、看图要顺时针转 90/270°」：
  // 这时宽高要**对调**，否则前端按 ar 摆出来的框是横的、照片是竖的（真机上 DSC03248 就是这样）。
  const swapped = (rec.meta.orientation ?? 1) >= 5;
  const w = swapped ? rec.meta.height : rec.meta.width;
  const h = swapped ? rec.meta.width : rec.meta.height;
  const sizeBytes = (rec.raw?.size ?? 0) + (rec.jpeg?.size ?? 0) + (rec.video?.size ?? 0);
  const mtimeMs = Math.max(rec.raw?.mtimeMs ?? 0, rec.jpeg?.mtimeMs ?? 0, rec.video?.mtimeMs ?? 0);
  return {
    id: rec.id,
    dir,
    displayName: rec.displayName,
    kind: rec.kind,
    ar: w && h ? w / h : 1,
    width: w,
    height: h,
    orientation: rec.meta.orientation,
    capturedAt: rec.meta.capturedAt ?? null,
    camera: rec.meta.camera ?? null,
    lens: rec.meta.lens ?? null,
    hasRaw: Boolean(rec.raw),
    hasJpeg: Boolean(rec.jpeg),
    rawPath: rec.raw ? virtualFilePath(dir, basename(rec.raw.path)) : null,
    jpegPath: rec.jpeg ? virtualFilePath(dir, basename(rec.jpeg.path)) : null,
    videoPath: rec.video ? virtualFilePath(dir, basename(rec.video.path)) : null,
    sizeBytes: sizeBytes || undefined,
    mtime: new Date(mtimeMs || Date.now()).toISOString(),
    stars: rec.stars,
    del: rec.del,
    preview: rec.previewSource,
    focusHint: rec.focusHint,
  };
}
