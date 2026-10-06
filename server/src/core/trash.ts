/**
 * 回收站：把「待删」这个标记变成真的搬走 —— 但还回得来。
 *
 * 设计要点（票 001/003 的结论）：
 *  - 文件搬进**同一个共享/目录**里的 `<照片目录>/.trash/<显示名>/`：`rename` 只在同一文件系统内原子，
 *    所以回收站必须待在照片自己的目录下，不能有个统一的库外回收站（NAS 上尤其如此）。
 *  - `dataDir/trash.jsonl` 追加记事件（in/out），重启后重放日志就能恢复现场；
 *    这也是「只有两处写磁盘」里被允许的第二处（另一处是 XMP）。
 *  - `.trash` 目录本身不参与扫描（`DEFAULT_IGNORE_DIRS`），所以搬进去的照片立刻从库里消失。
 *  - 真删只发生在 `empty()`：那是唯一一处 `rmSync`，且必须由调用方显式确认（契约里 `?confirm=true`）。
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { PhotoKind } from './photo.ts';

export const TRASH_DIR = '.trash';

export interface TrashFileMove {
  /** 原位（绝对路径） */
  from: string;
  /** 回收站里的落点（绝对路径） */
  to: string;
}

export interface TrashRecord {
  photoId: string;
  displayName: string;
  /** 虚拟路径：现在在哪（照片旁的 `.trash/<显示名>`） */
  dir: string;
  /** 虚拟路径：原来在哪 —— 还原就回这里 */
  fromDir: string;
  trashedAt: string;
  kind: PhotoKind;
  ar?: number;
  stars?: number;
  hasRaw: boolean;
  hasJpeg: boolean;
  sizeBytes?: number;
  /** 真实磁盘落点（只在本进程内使用，不出进程） */
  diskDir: string;
  diskFromDir: string;
  rootId: string;
  relDir: string;
  moves: TrashFileMove[];
}

type TrashEvent = { op: 'in'; rec: TrashRecord } | { op: 'out'; photoId: string; at: string };

export class TrashStore {
  private readonly byId = new Map<string, TrashRecord>();
  private readonly logFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.logFile = join(dataDir, 'trash.jsonl');
    this.load();
  }

  /** 重放日志：in 加进来、out 拿出去（最新的在前） */
  private load(): void {
    if (!existsSync(this.logFile)) return;
    let text: string;
    try {
      text = readFileSync(this.logFile, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as TrashEvent;
        if (ev.op === 'in' && ev.rec?.photoId) this.byId.set(ev.rec.photoId, ev.rec);
        else if (ev.op === 'out' && ev.photoId) this.byId.delete(ev.photoId);
      } catch {
        // 半行/坏行跳过：日志是追加的，崩溃时最后一行可能没写完
      }
    }
  }

  private append(ev: TrashEvent): void {
    try {
      appendFileSync(this.logFile, `${JSON.stringify(ev)}\n`, 'utf8');
    } catch {
      // 日志写不进去不该让动作失败（内存里已经生效）
    }
  }

  /** 回收站内容，最新的在前 */
  list(): TrashRecord[] {
    return [...this.byId.values()].sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
  }

  get(photoId: string): TrashRecord | undefined {
    return this.byId.get(photoId);
  }

  add(rec: TrashRecord): void {
    this.byId.set(rec.photoId, rec);
    this.append({ op: 'in', rec });
  }

  remove(photoId: string): void {
    this.byId.delete(photoId);
    this.append({ op: 'out', photoId, at: new Date().toISOString() });
  }
}

/** 搬一个文件；`rename` 优先（同设备原子），跨设备退化成复制+删 */
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** 在 `parent` 下找一个不重名的目录名：`名字`、`名字 (2)`、`名字 (3)`… */
export function uniqueDirName(parent: string, name: string): string {
  const clean = name.replace(/[/\\]/g, '_').trim() || 'photo';
  let candidate = clean;
  let n = 2;
  while (existsSync(join(parent, candidate))) {
    candidate = `${clean} (${n})`;
    n++;
    if (n > 999) throw new Error('同一个名字已经占了 999 次，放弃');
  }
  return candidate;
}

/** 还原时的落点：原位若已被新文件占住，就往后排号（绝不覆盖） */
export function uniqueFilePath(path: string): string {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  let n = 2;
  for (;;) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
    n++;
    if (n > 999) throw new Error('同名文件已经占了 999 个，放弃');
  }
}

/** 真删整个回收站目录（唯一一处 rmSync） */
export function removeTrashDir(diskDir: string): void {
  rmSync(diskDir, { recursive: true, force: true });
  // 顺手把空的 `.trash` 目录收掉；收不掉（还有别的照片在里面）就算了。
  // 注意用 rmdirSync：`rmSync` 不带 recursive 在 Linux 上不能删目录（EISDIR）。
  const parent = join(diskDir, '..');
  if (basename(parent) === TRASH_DIR) {
    try {
      rmdirSync(parent);
    } catch {
      // 非空或不许删：正常
    }
  }
}
