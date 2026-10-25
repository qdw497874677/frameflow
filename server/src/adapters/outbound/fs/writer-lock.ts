/** 单写者锁：dataDir 下 `connectors.lock`（O_EXCL + pid）；残留锁（进程已死）会被接管。 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { WriterLock } from '../../../application/connectors/ports.ts';

export const WRITER_LOCK = 'connectors.lock';

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class PidFileLock implements WriterLock {
  readonly #file: string;

  constructor(dataDir: string) { this.#file = join(dataDir, WRITER_LOCK); }

  acquire(): boolean {
    for (let i = 0; i < 2; i++) {
      try {
        const fd = fs.openSync(this.#file, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(fs.readFileSync(this.#file, 'utf8').trim());
        if (pidAlive(pid) && pid !== process.pid) return false;
        fs.rmSync(this.#file, { force: true });
      }
    }
    return false;
  }

  release(): void { fs.rmSync(this.#file, { force: true }); }
}
