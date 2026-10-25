/**
 * 飞书交互日志（actions/sessions/cursors/jpegs）通用 JSONL：与投递账本同一损坏策略（F31 后续）。
 * - 只容忍**最后一行无换行**的半写尾行（崩溃中断），视为未发生；
 * - 中间任何完整行解析失败 → 整个日志只读（`corrupt`），append 抛 STORE_CORRUPT（HTTP 映射 503），
 *   文件字节不被改写，等待人工处理；
 * - 文件以 0600 创建；append 只读最后 1 字节判断是否有半写尾行；有则从尾部向前找到最后一个换行并截掉半行
 *   （它本就视为未发生；若补换行保留它，下次加载会变成"中间损坏行"而把整个日志锁成只读）。
 * - compact 原子重写：写同目录临时文件 → fsync → rename 覆盖 → fsync 目录；任何一步崩溃，
 *   磁盘上要么是完整旧日志、要么是完整新日志（残留的 .tmp 由启动体检提示）。损坏日志拒绝压缩。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { shouldCompact, type CompactionPolicy } from '../../domain/maintenance/compaction.ts';

export class StoreCorruptError extends Error {
  readonly code = 'STORE_CORRUPT';
  readonly statusCode = 503;
  constructor(file: string, detail: string) { super(`STORE_CORRUPT: ${path.basename(file)} ${detail}`); }
}

export class JsonlLog<T> {
  readonly file: string;
  corrupt: string | null = null;
  /** 当前文件里的有效行数（load 与 append 维护），供压缩阈值判断 */
  lines = 0;
  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  load(): T[] {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { this.lines = 0; return []; }
    const lines = text.split('\n');
    const out: T[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const tail = i === lines.length - 1; // 无换行结尾的最后一段
      try { out.push(JSON.parse(line) as T); } catch { if (!tail) this.corrupt ??= `LINE_${i + 1}_INVALID_JSON`; }
    });
    this.lines = out.length;
    return out;
  }
  append(row: T): void {
    if (this.corrupt) throw new StoreCorruptError(this.file, this.corrupt);
    const fd = fs.openSync(this.file, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) fs.ftruncateSync(fd, lastNewlineEnd(fd, size)); // 截掉崩溃留下的半行
      }
      fs.writeSync(fd, JSON.stringify(row) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.lines += 1;
  }
  compact(rows: readonly T[]): void {
    if (this.corrupt) throw new StoreCorruptError(this.file, this.corrupt);
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, rows.map((r) => JSON.stringify(r) + '\n').join(''));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const dir = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.lines = rows.length;
  }
  /** 达到阈值才压缩；rows 惰性求值，未达阈值时不付快照成本 */
  compactIfNeeded(live: number, rows: () => readonly T[], policy?: CompactionPolicy): boolean {
    if (this.corrupt || !shouldCompact(this.lines, live, policy)) return false;
    this.compact(rows());
    return true;
  }
}

/** 从尾部按块向前找最后一个换行，返回其后一字节的偏移（没有换行则 0） */
function lastNewlineEnd(fd: number, size: number): number {
  const buf = Buffer.alloc(64 * 1024);
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - buf.length);
    const n = fs.readSync(fd, buf, 0, end - start, start);
    const i = buf.subarray(0, n).lastIndexOf(0x0a);
    if (i >= 0) return start + i + 1;
    end = start;
  }
  return 0;
}
