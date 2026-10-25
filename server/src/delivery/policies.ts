/**
 * 投递策略（F11）：`delivery-policies.json` 原子替换（0600，目录0700），纯函数匹配。
 * 匹配：启用 + event 相同 + projectIds 明确包含该项目；多条规则命中的同一目标只出现一次。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DELIVERY_EVENTS, type DeliveryEvent, type DeliveryPolicy, type PolicyDocument, type TargetRef } from './types.ts';

export const POLICIES_FILE = 'delivery-policies.json';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_POLICIES = 256;
const MAX_LIST = 256;
const MAX_FILE_BYTES = 1024 * 1024;

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
const fail = (code: string, detail?: string): never => { throw new PolicyError(code, detail); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function only(v: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail('UNKNOWN_FIELD', `${where}.${k}`);
}
function id(v: unknown, where: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail('INVALID_FIELD', where);
  return v as string;
}
function ids(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) fail('INVALID_FIELD', where);
  const out = (v as unknown[]).map((x, i) => id(x, `${where}[${i}]`));
  if (new Set(out).size !== out.length) fail('DUPLICATE_ENTRY', where);
  return out;
}

export function parseTargetRef(v: unknown, where: string): TargetRef {
  if (!isObj(v)) fail('INVALID_FIELD', where);
  const o = v as Record<string, unknown>;
  only(o, ['connectorId', 'targetId'], where);
  return { connectorId: id(o['connectorId'], `${where}.connectorId`), targetId: id(o['targetId'], `${where}.targetId`) };
}

export function parsePolicy(v: unknown, revision: number, where = 'policy'): DeliveryPolicy {
  if (!isObj(v)) fail('INVALID_FIELD', where);
  const o = v as Record<string, unknown>;
  only(o, ['id', 'enabled', 'projectIds', 'event', 'targets', 'revision'], where);
  if (typeof o['enabled'] !== 'boolean') fail('INVALID_FIELD', `${where}.enabled`);
  if (!DELIVERY_EVENTS.includes(o['event'] as DeliveryEvent)) fail('INVALID_FIELD', `${where}.event`);
  if (!Array.isArray(o['targets']) || o['targets'].length > MAX_LIST) fail('INVALID_FIELD', `${where}.targets`);
  const targets = (o['targets'] as unknown[]).map((t, i) => parseTargetRef(t, `${where}.targets[${i}]`));
  if (new Set(targets.map(key)).size !== targets.length) fail('DUPLICATE_ENTRY', `${where}.targets`);
  const rev = o['revision'] === undefined ? revision : o['revision'];
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) fail('INVALID_FIELD', `${where}.revision`);
  return {
    id: id(o['id'], `${where}.id`), enabled: o['enabled'] as boolean, projectIds: ids(o['projectIds'], `${where}.projectIds`),
    event: o['event'] as DeliveryEvent, targets, revision: rev as number,
  };
}

export const key = (t: TargetRef): string => `${t.connectorId}\u0000${t.targetId}`;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}

export function parsePolicyDocument(v: unknown): PolicyDocument {
  if (!isObj(v)) fail('INVALID_DOCUMENT');
  const o = v as Record<string, unknown>;
  only(o, ['version', 'revision', 'policies'], 'document');
  if (o['version'] !== 1) fail('UNSUPPORTED_VERSION');
  const rev = o['revision'];
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) fail('INVALID_DOCUMENT', 'revision');
  if (!Array.isArray(o['policies']) || o['policies'].length > MAX_POLICIES) fail('INVALID_DOCUMENT', 'policies');
  const policies = (o['policies'] as unknown[]).map((p, i) => parsePolicy(p, rev as number, `policies[${i}]`));
  if (new Set(policies.map((p) => p.id)).size !== policies.length) fail('DUPLICATE_POLICY');
  return deepFreeze({ version: 1, revision: rev as number, policies });
}

/** 纯函数：项目+事件匹配，目标去重，保持首次出现顺序 */
export function matchTargets(doc: PolicyDocument, projectId: string, event: DeliveryEvent): TargetRef[] {
  const seen = new Set<string>();
  const out: TargetRef[] = [];
  for (const p of doc.policies) {
    if (!p.enabled || p.event !== event || !p.projectIds.includes(projectId)) continue;
    for (const t of p.targets) {
      if (seen.has(key(t))) continue;
      seen.add(key(t));
      out.push(t);
    }
  }
  return out;
}

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
    let doc: PolicyDocument = deepFreeze({ version: 1, revision: 0, policies: [] });
    if (fs.existsSync(file)) {
      let raw: unknown;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('CONFIG_CORRUPT'); }
      doc = parsePolicyDocument(raw);
    }
    return new PolicyStore(dataDir, doc);
  }

  get current(): PolicyDocument { return this.#current; }

  /** 原子替换；被修改/新增的策略 revision 记为新文档 revision */
  replace(policies: readonly unknown[], expectedRevision: number): PolicyDocument {
    if (expectedRevision !== this.#current.revision) fail('REVISION_CONFLICT');
    const nextRev = this.#current.revision + 1;
    const old = new Map(this.#current.policies.map((p) => [p.id, p]));
    const stamped = policies.map((p) => {
      if (!isObj(p)) return p;
      const { revision: _r, ...rest } = p as Record<string, unknown>;
      const prev = typeof rest['id'] === 'string' ? old.get(rest['id']) : undefined;
      const parsedProbe = parsePolicy(rest, nextRev);
      const same = prev && JSON.stringify({ ...prev, revision: 0 }) === JSON.stringify({ ...parsedProbe, revision: 0 });
      return { ...rest, revision: same ? prev!.revision : nextRev };
    });
    const next = parsePolicyDocument({ version: 1, revision: nextRev, policies: stamped });
    const body = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (body.length > MAX_FILE_BYTES) fail('CONFIG_TOO_LARGE');
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
