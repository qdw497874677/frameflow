/**
 * 投递策略（F11）：`delivery-policies.json` 原子替换（0600，目录0700），匹配规则见 domain/delivery/policy.ts。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PolicyDocument } from '../../../domain/delivery/types.ts';
import { EMPTY_POLICY_DOCUMENT, PolicyError, nextPolicyDocument, parsePolicyDocument } from '../../../domain/delivery/policy.ts';

export const POLICIES_FILE = 'delivery-policies.json';
const MAX_FILE_BYTES = 1024 * 1024;

export class PolicyStore {
  #current: PolicyDocument;
  readonly #dir: string;
  readonly #file: string;

  private constructor(dir: string, doc: PolicyDocument) {
    this.#dir = dir;
    this.#file = path.join(dir, POLICIES_FILE);
    this.#current = doc;
  }

  static open(dataDir: string): PolicyStore {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, POLICIES_FILE);
    let doc: PolicyDocument = EMPTY_POLICY_DOCUMENT;
    if (fs.existsSync(file)) {
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new PolicyError('CONFIG_CORRUPT'); }
      doc = parsePolicyDocument(raw);
    }
    return new PolicyStore(dataDir, doc);
  }

  get current(): PolicyDocument { return this.#current; }

  /** 原子替换；被修改/新增的策略 revision 记为新文档 revision */
  replace(policies: readonly unknown[], expectedRevision: number): PolicyDocument {
    if (expectedRevision !== this.#current.revision) throw new PolicyError('REVISION_CONFLICT');
    const next = nextPolicyDocument(this.#current, policies);
    const body = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (body.length > MAX_FILE_BYTES) throw new PolicyError('CONFIG_TOO_LARGE');
    fs.chmodSync(this.#dir, 0o700);
    const tmp = path.join(this.#dir, `.${POLICIES_FILE}.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    const dfd = fs.openSync(this.#dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    this.#current = next;
    return next;
  }
}
