/** 追加式 jsonl：写入即 fsync；加载时跳过半行（崩溃尾部）。 */
import * as fs from 'node:fs';
import path from 'node:path';

export class JsonlLog<T> {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  load(): T[] {
    if (!fs.existsSync(this.file)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as T); } catch { /* 半写尾行 */ }
    }
    return out;
  }
  append(row: T): void {
    const fd = fs.openSync(this.file, 'a');
    try {
      // 若上次崩溃留下无换行半行，先补换行隔开
      const size = fs.fstatSync(fd).size;
      const prefix = size > 0 && !fs.readFileSync(this.file).subarray(size - 1).equals(Buffer.from('\n')) ? '\n' : '';
      fs.writeSync(fd, prefix + JSON.stringify(row) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}
