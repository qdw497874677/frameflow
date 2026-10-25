/**
 * 数据目录的文件系统适配器：体检用的只读视图 + 备份。
 *
 * 备份把数据目录（索引、标记、任务、连接器 / 投递 / 飞书各存储）原样复制到
 * `<dest>/frameflow-backup-<时间戳>/`，并写一份含 sha256 的 manifest.json。
 * 照片原文件不复制：它们在用户自己的库目录里，体积大且本就由用户管理。
 */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { DataDirRepairer } from '../../../application/maintenance/ports.ts';

function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(root, p);
    return e.isFile() ? [relative(root, p)] : [];
  });
}

export class DataDirFiles implements DataDirRepairer {
  readonly root: string;
  /** 缩略图 / 预览可再生，不体检也不备份 */
  readonly skip: string[];
  constructor(root: string, skip: string[] = ['thumbs', 'previews']) {
    this.root = root;
    this.skip = skip;
  }

  list(): string[] {
    return filesUnder(this.root).filter((f) => !this.skip.some((s) => f === s || f.startsWith(`${s}/`)));
  }

  read(file: string): string {
    return readFileSync(join(this.root, file), 'utf8');
  }

  backupAndReplace(file: string, text: string, now = new Date()): string {
    const backup = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}.bak`;
    const abs = join(this.root, file);
    copyFileSync(abs, join(this.root, backup));
    const tmp = `${abs}.repair.tmp`;
    writeFileSync(tmp, text, { mode: statSync(abs).mode & 0o777 });
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, abs);
    return backup;
  }
}

export interface BackupResult { dir: string; files: number }

export function backupDataDir(data: DataDirFiles, dest: string, now = new Date()): BackupResult {
  if (!existsSync(data.root)) throw new Error(`数据目录不存在：${data.root}`);
  const inside = relative(resolve(data.root), resolve(dest));
  if (!inside.startsWith('..') && !inside.startsWith('/')) throw new Error('备份目标不能在数据目录内');
  const dir = join(dest, `frameflow-backup-${now.toISOString().replace(/[:.]/g, '-')}`);
  const files = data.list().filter((f) => !f.endsWith('.tmp'));
  const manifest = files.map((f) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(data.root, f), join(dir, f));
    return { file: f, sha256: createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') };
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: now.toISOString(), source: data.root, files: manifest }, null, 2));
  return { dir, files: files.length };
}
