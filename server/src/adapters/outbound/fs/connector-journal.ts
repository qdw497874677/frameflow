import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface JournalEnvelope {
  readonly version: 1;
  readonly sequence: number;
  readonly id: string;
  readonly payload: unknown;
  readonly checksum: string;
}
export interface TailRepair {
  readonly code: 'TRUNCATED_TAIL_REPAIRED';
  readonly offset: number;
  readonly removedBytes: number;
}
export interface JournalOptions {
  /** Default false: recovery must be explicitly authorized, and inspect `repair`. */
  repairTail?: boolean;
  /** Trusted, nonreentrant recovery fsync seam, separate from append I/O.
   * Same contract as io; called for file, parent directory, then repaired file.
   * Any failure aborts open; truncation may already have happened. */
  recoverySync?: (fd: number) => void;
  /** Trusted synchronous fault-injection seam; defaults to real write/fsync.
   * Callbacks MUST NOT reenter journal/guard operations (including close/release),
   * mutate files/locks except the requested I/O, or claim success without doing I/O. */
  io?: {
    write(fd: number, bytes: Buffer): number;
    sync(fd: number): void;
  };
}
interface GuardCallbacks { assertOwned(): void; closed(): void }
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function body(record: Omit<JournalEnvelope, 'checksum'>): string {
  return JSON.stringify({ version: record.version, sequence: record.sequence, id: record.id, payload: record.payload });
}
function validId(id: unknown): id is string { return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id); }

/**
 * Bounded version-1 JSONL, SHA-256 over canonical envelope field order, newline commit marker.
 * append returns only after fsync. On error the result is UNKNOWN (a complete record can
 * survive a failed fsync); reopen/replay and reconcile stable IDs, never blindly retry.
 * IDs are correlation keys, NOT automatic deduplication. Payload schemas belong to callers.
 * Checksums detect damage, not malicious tampering. No network filesystem/hardware guarantee.
 * Synchronous I/O serializes append/close/release within a process. Bounds are deliberately
 * fixed; compaction/rotation and production wiring are future work, never silently truncate.
 */
export class Journal {
  readonly repair: Readonly<TailRepair> | undefined;
  readonly #fd: number;
  readonly #guard: GuardCallbacks;
  readonly #io: NonNullable<JournalOptions['io']>;
  readonly #records: JournalEnvelope[];
  #size: number;
  #closed = false;
  #poisoned = false;

  private constructor(fd: number, guard: GuardCallbacks, options: JournalOptions, records: JournalEnvelope[], size: number, repair?: TailRepair) {
    this.#fd = fd; this.#guard = guard; this.#records = records; this.#size = size;
    this.repair = repair && Object.freeze(repair);
    this.#io = options.io ?? { write: (fd, bytes) => fs.writeSync(fd, bytes), sync: fs.fsyncSync };
  }

  /** @internal Only WriterGuard.openJournal may call this. Callbacks MUST come from a
   * live exclusive guard and reserve the pathname until close. Not a standalone writer API.
   * This module boundary is a trusted-code contract, not a sandbox against arbitrary JS. */
  static openGuarded(file: string, guard: GuardCallbacks, options: JournalOptions): Journal {
    guard.assertOwned();
    let fd: number;
    const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    try {
      fd = fs.openSync(file, flags | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      fd = fs.openSync(file, flags);
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('INVALID_JOURNAL_FILE');
      if (stat.size > MAX_JOURNAL_BYTES) throw new Error('JOURNAL_TOO_LARGE');
      const recoverySync = options.recoverySync ?? fs.fsyncSync;
      // Also sync existing files: a previous creation/flush may have failed ambiguously.
      recoverySync(fd);
      const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { recoverySync(dirFd); } finally { fs.closeSync(dirFd); }
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
        if (count === 0) throw new Error('JOURNAL_CHANGED');
        read += count;
      }
      const records: JournalEnvelope[] = [];
      let offset = 0;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset);
        if (end === -1) break;
        if (end - offset + 1 > MAX_RECORD_BYTES || records.length >= MAX_RECORDS) throw new Error('CORRUPT_RECORD: bounds');
        try {
          const encoded = bytes.subarray(offset, end);
          const text = encoded.toString('utf8');
          // Reject lossy decoding before canonical/checksum validation: an invalid byte
          // must never impersonate a legitimate, checksummed U+FFFD character.
          if (!Buffer.from(text, 'utf8').equals(encoded)) throw new Error('invalid UTF-8');
          const record = JSON.parse(text) as JournalEnvelope;
          if (!record || record.version !== 1 || record.sequence !== records.length + 1 || !validId(record.id)
            || !Object.hasOwn(record, 'payload') || typeof record.checksum !== 'string'
            || record.checksum !== digest(body(record))
            || text !== JSON.stringify({ ...JSON.parse(body(record)), checksum: record.checksum })) throw new Error('invalid envelope');
          records.push(record);
        } catch { throw new Error(`CORRUPT_RECORD: offset ${offset}`); }
        offset = end + 1;
      }
      let repair: TailRepair | undefined;
      if (offset !== bytes.length) {
        if (!options.repairTail) throw new Error(`TRUNCATED_TAIL: offset ${offset}`);
        // All complete records validated before changing ANY bytes.
        guard.assertOwned();
        fs.ftruncateSync(fd, offset);
        recoverySync(fd);
        repair = { code: 'TRUNCATED_TAIL_REPAIRED', offset, removedBytes: bytes.length - offset };
      }
      return new Journal(fd, guard, options, records, offset, repair);
    } catch (error) { fs.closeSync(fd); throw error; }
  }

  get records(): readonly JournalEnvelope[] { return structuredClone(this.#records); }

  append(id: string, payload: unknown): JournalEnvelope {
    if (this.#closed) throw new Error('JOURNAL_CLOSED');
    if (this.#poisoned) throw new Error('JOURNAL_POISONED: close and recover before writing');
    this.#guard.assertOwned();
    if (!validId(id) || payload === undefined) throw new Error('INVALID_RECORD');
    // Snapshot before I/O; JSON serialization errors have not touched the file.
    const payloadText = JSON.stringify(payload);
    if (payloadText === undefined) throw new Error('INVALID_RECORD');
    // toJSON/getters may execute caller code; recheck lifecycle and assign sequence AFTER it.
    if (this.#closed) throw new Error('JOURNAL_CLOSED');
    if (this.#poisoned) throw new Error('JOURNAL_POISONED');
    this.#guard.assertOwned();
    const snapshot = { version: 1 as const, sequence: this.#records.length + 1, id, payload: JSON.parse(payloadText) as unknown };
    const serialized = body(snapshot);
    const record: JournalEnvelope = { ...snapshot, checksum: digest(serialized) };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('RECORD_TOO_LARGE');
    if (this.#size + bytes.length > MAX_JOURNAL_BYTES || this.#records.length >= MAX_RECORDS) throw new Error('JOURNAL_TOO_LARGE');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = this.#io.write(this.#fd, bytes.subarray(offset));
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error('INVALID_WRITE_RESULT');
        offset += written;
      }
      this.#io.sync(this.#fd);
    } catch (error) { this.#poisoned = true; throw error; }
    this.#size += bytes.length;
    this.#records.push(record);
    return structuredClone(record);
  }

  close(): void {
    if (this.#closed) return;
    // A failed close retains the reservation; it must not permit another writer.
    fs.closeSync(this.#fd);
    this.#closed = true;
    this.#guard.closed();
  }
}
