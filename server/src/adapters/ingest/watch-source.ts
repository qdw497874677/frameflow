/**
 * 入站适配器：监听收件目录（递归）。任何方式拷进来的文件（SMB、rsync、相机 App……）都会报到入库服务。
 *
 * `fs.watch` 只报「有动静」不报「写完了」—— 所以这里一律 `complete: false`，由应用层的稳定判定兜底。
 * 启动时顺带把收件目录里已有的文件报一遍（停机期间进来的不丢）。
 */

import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { IngestSink, IngestSource } from '../../application/ingest/ports.ts';

export class WatchIngestSource implements IngestSource {
  readonly kind = 'watch' as const;
  private watcher: FSWatcher | null = null;
  private events = 0;
  private lastError: string | null = null;
  private readonly rootId: string;
  private readonly rootPath: string;
  private readonly baseRel: string;

  /** `baseRel`：根目录下要监听的子树（收件目录模板 `{date}` 之前的那段） */
  constructor(opts: { rootId: string; rootPath: string; baseRel: string }) {
    this.rootId = opts.rootId;
    this.rootPath = opts.rootPath;
    this.baseRel = opts.baseRel;
  }

  private get baseAbs(): string {
    return this.baseRel ? join(this.rootPath, ...this.baseRel.split('/')) : this.rootPath;
  }

  async start(sink: IngestSink): Promise<void> {
    await mkdir(this.baseAbs, { recursive: true });
    const report = (abs: string) => {
      const rel = relative(this.rootPath, abs).split(sep).join('/');
      if (!rel || rel.startsWith('..')) return;
      const i = rel.lastIndexOf('/');
      this.events++;
      sink.arrived({ rootId: this.rootId, relDir: i < 0 ? '' : rel.slice(0, i), name: i < 0 ? rel : rel.slice(i + 1), complete: false });
    };
    this.watcher = watch(this.baseAbs, { recursive: true, persistent: false }, (_type, file) => {
      if (file) report(join(this.baseAbs, String(file)));
    });
    this.watcher.on('error', (err) => { this.lastError = err.message; });
    // 停机期间进来的：启动扫一遍（入库按目录幂等，已在库里的不会重复报新）
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
        else if (e.isFile()) report(join(dir, e.name));
      }
    };
    await walk(this.baseAbs, 0);
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
  }

  status(): Record<string, unknown> {
    return { running: this.watcher !== null, dir: this.baseRel, events: this.events, lastError: this.lastError };
  }
}
