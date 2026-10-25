import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { MarkInput, MarkState, MarkChange, MarkResultDto } from './marks.ts';

export interface MarkTransactionRequest {
  opId: string;
  items: MarkInput[];
  /** Checked against the pre-batch revision, including when a photo occurs twice. */
  expectedRevisions?: Record<string, number>;
  confirmation?: Record<string, unknown>;
}
export interface MarkTransactionResult {
  opId: string;
  results: MarkResultDto[];
  revisions: Record<string, number>;
}
export interface MarkEntry {
  id: string;
  expectedRevision: number;
  newRevision: number;
  state: MarkState;
  changes: MarkChange[];
}
export interface MarkEnvelope {
  version: 1;
  kind: 'mark-transaction';
  opId: string;
  requestHash: string;
  entries: MarkEntry[];
  confirmation?: Record<string, unknown>;
  result: MarkTransactionResult;
  checksum: string;
}
export interface MarksLogOptions {
  repairTail?: boolean;
  /** Trusted synchronous fault injection only. */
  io?: { write(fd: number, bytes: Buffer): number; sync(fd: number): void };
}
export interface MarkTailRepair { offset: number; removedBytes: number; code: 'TRUNCATED_TAIL_REPAIRED' }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const stars = (v: unknown): boolean => revision(v) && (v as number) <= 5;
const text = (v: unknown): v is string => typeof v === 'string';
const id = (v: unknown): v is string => text(v) && v.length > 0;

/** Sorted object keys, ordered arrays, JSON-only values; never hash lossy JSON coercions. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('INVALID_MARK_TRANSACTION: sparse array');
      items.push(canonical(value[i]));
    }
    return '[' + items.join(',') + ']';
  }
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new Error('INVALID_MARK_TRANSACTION: non-JSON value');
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function validInput(v: unknown): v is MarkInput {
  if (!object(v) || !id(v.id)) return false;
  return (v.stars === undefined || (typeof v.stars === 'number' && Number.isFinite(v.stars))) &&
    (v.del === undefined || typeof v.del === 'boolean') &&
    ['by', 'channel', 'at'].every(k => v[k] === undefined || text(v[k])) &&
    (v.jobId === undefined || v.jobId === null || text(v.jobId));
}
export function validateRequest(r: MarkTransactionRequest): void {
  if (!object(r) || !id(r.opId) || r.opId.length > 200 || !Array.isArray(r.items) ||
      (r.expectedRevisions !== undefined && (!object(r.expectedRevisions) || !Object.entries(r.expectedRevisions).every(([k, v]) => id(k) && revision(v)))) ||
      (r.confirmation !== undefined && !object(r.confirmation))) throw new Error('INVALID_MARK_TRANSACTION');
  canonical(r); // Internal callers must send a lossless JSON request.
}
export function validChange(v: unknown): v is MarkChange {
  if (!object(v) || !id(v.photoId) || !['stars', 'del'].includes(String(v.field))) return false;
  const value = (x: unknown) => x === null || (v.field === 'stars' ? stars(x) : typeof x === 'boolean');
  return value(v.from) && value(v.to) && ['by', 'channel', 'at'].every(k => text(v[k])) &&
    (v.displayName === undefined || text(v.displayName)) && (v.jobId === undefined || v.jobId === null || text(v.jobId));
}
export function parseRow(line: string): MarkChange | MarkEnvelope {
  try {
    const v: unknown = JSON.parse(line);
    if (!object(v)) throw Error();
    if (!('version' in v)) {
      if ('kind' in v || !validChange(v)) throw Error();
      return v;
    }
    const { checksum, ...body } = v;
    if (v.version !== 1 || v.kind !== 'mark-transaction' || !id(v.opId) ||
        !text(v.requestHash) || !/^[a-f0-9]{64}$/.test(v.requestHash) || checksum !== hash(body) ||
        !Array.isArray(v.entries) || !object(v.result) || v.result.opId !== v.opId ||
        !Array.isArray(v.result.results) || !object(v.result.revisions) ||
        !Object.values(v.result.revisions).every(revision) ||
        (v.confirmation !== undefined && !object(v.confirmation))) throw Error();
    for (const e of v.entries) {
      if (!object(e) || !id(e.id) || !revision(e.expectedRevision) || !revision(e.newRevision) ||
          e.newRevision !== e.expectedRevision + 1 || !object(e.state) || !stars(e.state.stars) ||
          typeof e.state.del !== 'boolean' || (e.state.del && e.state.stars !== 0) ||
          !['by', 'channel', 'at'].every(k => text((e.state as Record<string, unknown>)[k])) ||
          !Array.isArray(e.changes) || !e.changes.every(c => validChange(c) && c.photoId === e.id)) throw Error();
    }
    for (const r of v.result.results) {
      if (!object(r) || !text(r.id) || typeof r.ok !== 'boolean' ||
          (r.ok && (!stars(r.stars) || typeof r.del !== 'boolean')) ||
          (r.error !== undefined && r.error !== null && !text(r.error))) throw Error();
    }
    const envelope = v as unknown as MarkEnvelope;
    const successful = envelope.result.results.filter(r => r.ok);
    if (successful.length !== envelope.entries.length) throw Error();
    const finalRevisions = new Map<string, number>();
    envelope.entries.forEach((entry, i) => {
      const result = successful[i];
      if (result.id !== entry.id || result.stars !== entry.state.stars || result.del !== entry.state.del ||
          entry.changes.some(ch => ch.to !== entry.state[ch.field] || ch.by !== entry.state.by ||
            ch.channel !== entry.state.channel || ch.at !== entry.state.at)) throw Error();
      finalRevisions.set(entry.id, entry.newRevision);
    });
    if (canonical(Object.fromEntries(finalRevisions)) !== canonical(envelope.result.revisions)) throw Error();
    return envelope;
  } catch { throw new Error('MARKS_CORRUPT: invalid complete row'); }
}

/** Validate the entire complete prefix before recovery is allowed to mutate the file. */
function validateReplay(rows: readonly (MarkChange | MarkEnvelope)[]): void {
  const operations = new Set<string>();
  const revisions = new Map<string, number>();
  for (const row of rows) {
    if ('version' in row) {
      if (operations.has(row.opId)) throw new Error('MARKS_CORRUPT: duplicate operation');
      operations.add(row.opId);
      for (const entry of row.entries) {
        if (entry.expectedRevision !== (revisions.get(entry.id) ?? 0)) throw new Error('MARKS_CORRUPT: revision chain');
        revisions.set(entry.id, entry.newRevision);
      }
    } else {
      revisions.set(row.photoId, (revisions.get(row.photoId) ?? 0) + 1);
    }
  }
}

/** Mixed legacy/new log, deliberately NOT the connectors' strict Journal format. */
export class MarksLog {
  readonly repair?: MarkTailRepair;
  readonly rows: (MarkChange | MarkEnvelope)[] = [];
  private poisoned = false;
  private readonly file: string;
  private readonly io: NonNullable<MarksLogOptions['io']>;
  constructor(file: string, options: MarksLogOptions = {}) {
    this.file = file;
    this.io = options.io ?? { write: fs.writeSync, sync: fs.fsyncSync };
    if (!fs.existsSync(file)) return;
    const fd = fs.openSync(file, 'r+');
    try {
      const bytes = fs.readFileSync(fd);
      const end = bytes.lastIndexOf(10) + 1;
      const complete = bytes.subarray(0, end);
      const decoded = complete.toString('utf8');
      // Reject lossy replacement decoding, including in legacy rows without checksums.
      if (!Buffer.from(decoded, 'utf8').equals(complete)) throw new Error('MARKS_CORRUPT: invalid UTF-8');
      for (const line of decoded.split('\n').slice(0, -1)) this.rows.push(parseRow(line));
      validateReplay(this.rows);
      if (end !== bytes.length) {
        if (!options.repairTail) throw new Error('MARKS_TRUNCATED_TAIL: explicit repairTail required');
        this.repair = { code: 'TRUNCATED_TAIL_REPAIRED', offset: end, removedBytes: bytes.length - end };
        fs.ftruncateSync(fd, end);
      }
      // A surviving complete row after a failed flush is not committed until recovery flush.
      this.io.sync(fd);
      this.syncDirectory();
    } finally { fs.closeSync(fd); }
  }
  assertWritable(): void { if (this.poisoned) throw new Error('MARKS_POISONED: reopen and reconcile opId'); }
  private syncDirectory(): void {
    const fd = fs.openSync(dirname(this.file), 'r');
    try { this.io.sync(fd); } finally { fs.closeSync(fd); }
  }
  append(record: MarkEnvelope): void {
    this.assertWritable();
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    // open errors (e.g. directory at log path) provably precede any append and permit retry.
    const fd = fs.openSync(this.file, 'a');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.io.write(fd, bytes.subarray(offset));
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw Error('short write');
        offset += count;
      }
      this.io.sync(fd);
      this.syncDirectory(); // Includes creation and recovery from an earlier uncertain create.
    } catch (error) {
      this.poisoned = true;
      throw new Error(`MARKS_COMMIT_UNKNOWN: ${String(error)}`);
    } finally { fs.closeSync(fd); }
  }
}
