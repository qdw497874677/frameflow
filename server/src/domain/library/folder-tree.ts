/** 内存目录树：每层直属照片 + 递归计数 + 父子边。纯数据结构，由扫描结果重建。 */

import { dirPath } from '../ids.ts';
import type { PhotoRecord } from '../photo.ts';

interface DirStat {
  /** 本目录直接含有的照片对数 */
  direct: number;
  /** 含子目录在内的照片对数 */
  recursive: number;
  children: Set<string>;
}

export interface FolderEntry {
  name: string;
  path: string;
  photoCount: number;
  hasSubfolders: boolean;
}

export function byName(a: PhotoRecord, b: PhotoRecord): number {
  return a.displayName.localeCompare(b.displayName, 'en', { numeric: true, sensitivity: 'base' });
}

export class FolderTree {
  private readonly byDir = new Map<string, PhotoRecord[]>();
  private readonly dirs = new Map<string, DirStat>();

  rebuild(records: Iterable<PhotoRecord>, rootIds: string[]): void {
    this.byDir.clear();
    this.dirs.clear();
    for (const rec of records) {
      const dir = dirPath(rec.rootId, rec.relDir);
      const bucket = this.byDir.get(dir);
      if (bucket) bucket.push(rec);
      else this.byDir.set(dir, [rec]);

      // 目录统计：本层 + 每一层祖先（递归数），并且把**每一级父子边**都补上。
      // 只连「照片所在目录的上一级」是不够的 —— 那样 `/test` 到 `/test/项目/机身` 中间没有边，
      // 目录树从根往下走不动（前端侧边栏会显示成一个空壳子）。
      this.stat(dir).direct++;
      const parts = dir.split('/').filter(Boolean); // [rootId, ...relDir]
      for (let i = parts.length; i >= 1; i--) {
        const ancestor = `/${parts.slice(0, i).join('/')}`;
        this.stat(ancestor).recursive++;
        if (i > 1) this.stat(`/${parts.slice(0, i - 1).join('/')}`).children.add(ancestor);
      }
    }
    for (const list of this.byDir.values()) list.sort(byName);
    // 根目录自身：即使一张照片都没有也要在树里可见
    for (const id of rootIds) this.stat(`/${id}`);
  }

  private stat(dir: string): DirStat {
    let s = this.dirs.get(dir);
    if (!s) {
      s = { direct: 0, recursive: 0, children: new Set() };
      this.dirs.set(dir, s);
    }
    return s;
  }

  has(dir: string): boolean {
    return this.dirs.has(dir);
  }

  /** 递归照片数 */
  photoCount(dir: string): number {
    return this.dirs.get(dir)?.recursive ?? 0;
  }

  directCount(dir: string): number {
    return this.dirs.get(dir)?.direct ?? 0;
  }

  entry(dir: string, name: string): FolderEntry {
    return { name, path: dir, photoCount: this.photoCount(dir), hasSubfolders: Boolean(this.dirs.get(dir)?.children.size) };
  }

  subfolders(dir: string): FolderEntry[] {
    return [...(this.dirs.get(dir)?.children ?? [])]
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
      .map((child) => this.entry(child, child.slice(child.lastIndexOf('/') + 1)));
  }

  direct(dir: string): PhotoRecord[] {
    return this.byDir.get(dir) ?? [];
  }

  /** 目录之下（含自身）所有层级的照片：先按目录、再按文件名排（一个子目录一段） */
  under(dir: string): PhotoRecord[] {
    const out: PhotoRecord[] = [];
    const walk = (d: string): void => {
      out.push(...this.direct(d));
      for (const child of this.dirs.get(d)?.children ?? []) walk(child);
    };
    walk(dir);
    return out.sort((a, b) => {
      const byDirCmp = dirPath(a.rootId, a.relDir).localeCompare(dirPath(b.rootId, b.relDir), 'zh', { numeric: true });
      return byDirCmp !== 0 ? byDirCmp : byName(a, b);
    });
  }
}
