import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal } from './connector-journal.ts';
import type { JournalOptions } from './connector-journal.ts';

export interface WriterIdentity {
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: string;
  readonly token: string;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * OFFLINE primitive, not installed in the server lifecycle.
 * Local Linux filesystem only; dataDir must already exist and be administrator-owned.
 * Never auto-steals ANY occupied lock, including malformed/empty/dead-PID locks.
 * Manual recovery: stop ALL users of dataDir, verify bootId + /proc/PID/stat field 22
 * (not merely PID existence), archive the lock and inspect journals, then remove it.
 * Never manipulate locks while processes are running. Like other pathname locks,
 * this is cooperative exclusion, not protection against a same-UID filesystem attacker.
 */
export class WriterGuard {
  readonly identity: Readonly<WriterIdentity>;
  readonly #directory: string;
  readonly #lock: string;
  readonly #inode: fs.Stats;
  #released = false;
  readonly #journals = new Set<string>();

  private constructor(directory: string, lock: string, inode: fs.Stats, identity: WriterIdentity) {
    this.#directory = directory;
    this.#lock = lock;
    this.#inode = inode;
    this.identity = Object.freeze(identity);
  }

  static acquire(dataDir: string): WriterGuard {
    if (process.platform !== 'linux') throw new Error('UNSUPPORTED_PLATFORM: Linux process identity required');
    const directory = fs.realpathSync(dataDir);
    if (!fs.statSync(directory).isDirectory()) throw new Error('INVALID_DIRECTORY');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/^\d+$/.test(startTicks) || !/^[a-f0-9-]{36}$/.test(bootId)) throw new Error('IDENTITY_UNAVAILABLE');
    const identity = { pid: process.pid, bootId, startTicks, token: randomUUID() };
    const lock = path.join(directory, '.connector-writer.lock');
    let fd: number;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('LOCK_OCCUPIED: manual recovery required');
      throw error;
    }
    // Any initialization failure intentionally leaves an occupied lock for manual recovery.
    try {
      fs.writeFileSync(fd, JSON.stringify(identity) + '\n');
      fs.fsyncSync(fd);
      syncDirectory(directory);
      return new WriterGuard(directory, lock, fs.fstatSync(fd), identity);
    } finally { fs.closeSync(fd); }
  }

  #assertOwned(): void {
    if (this.#released) throw new Error('LOCK_LOST');
    let current: fs.Stats;
    try { current = fs.lstatSync(this.#lock); } catch { throw new Error('LOCK_LOST'); }
    if (!current.isFile() || current.dev !== this.#inode.dev || current.ino !== this.#inode.ino) throw new Error('LOCK_LOST');
    if (fs.readFileSync(this.#lock, 'utf8') !== JSON.stringify(this.identity) + '\n') throw new Error('LOCK_LOST');
  }

  openJournal(name: string, options: JournalOptions = {}): Journal {
    this.#assertOwned();
    if (!/^[a-z][a-z0-9-]{0,63}\.jsonl$/.test(name)) throw new Error('INVALID_NAME');
    if (this.#journals.has(name)) throw new Error('JOURNAL_OPEN');
    this.#journals.add(name);
    try {
      return Journal.openGuarded(path.join(this.#directory, name), {
        assertOwned: () => this.#assertOwned(),
        closed: () => this.#journals.delete(name),
      }, options);
    } catch (error) { this.#journals.delete(name); throw error; }
  }

  release(): void {
    if (this.#released) return;
    if (this.#journals.size) throw new Error('JOURNALS_OPEN');
    this.#assertOwned();
    // Synchronous owner-token + inode check; no await between check and removal.
    fs.unlinkSync(this.#lock);
    this.#released = true;
    syncDirectory(this.#directory);
  }
}
