/** ExportTarget：成品写到 FrameFlow 数据目录 `exports/<jobId>/`（原片不动；同名覆盖 = 重导） */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExportTarget } from '../../../application/grading/ports.ts';

export class DirExportTarget implements ExportTarget {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'exports');
  }

  locate(jobId: string): string {
    if (!/^[\w-]+$/.test(jobId)) throw new Error(`任务 id 不合法：${jobId}`);
    return path.join(this.root, jobId);
  }

  async write(jobId: string, fileName: string, data: Uint8Array): Promise<{ path: string; bytes: number }> {
    const dir = this.locate(jobId);
    const file = path.join(dir, path.basename(fileName));
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
    return { path: file, bytes: data.byteLength };
  }
}
