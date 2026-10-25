import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ConnectorConfigDocument, ConnectorInstanceConfig, ConnectorTarget, SanitizedConnectorInstance,
} from './types.ts';

/** connectors.json：非密钥配置，原子替换，目录0700/文件0600。 */
export const CONNECTORS_FILE = 'connectors.json';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INSTANCES = 32;
const MAX_TARGETS = 256;
const MAX_LIST = 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const FORBIDDEN_KEYS = new Set(['secret', 'appsecret', 'app_secret', 'secretvalue', 'password', 'token']);

export class ConnectorConfigError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

type Obj = Record<string, unknown>;
function isObj(v: unknown): v is Obj { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function fail(code: string, detail?: string): never { throw new ConnectorConfigError(code, detail); }

function rejectSecrets(v: unknown, where: string): void {
  if (Array.isArray(v)) { v.forEach((x, i) => rejectSecrets(x, `${where}[${i}]`)); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) fail('RAW_SECRET_FORBIDDEN', `${where}.${k}`);
    rejectSecrets(x, `${where}.${k}`);
  }
}
function only(o: Obj, keys: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail('UNKNOWN_FIELD', `${where}.${k}`);
}
function str(o: Obj, k: string, where: string, max = 256): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || v.trim() !== v) fail('INVALID_FIELD', `${where}.${k}`);
  return v;
}
function id(o: Obj, k: string, where: string): string {
  const v = str(o, k, where, 128);
  if (!ID_RE.test(v)) fail('INVALID_FIELD', `${where}.${k}`);
  return v;
}
function bool(o: Obj, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') fail('INVALID_FIELD', `${where}.${k}`);
  return v;
}
function idList(o: Obj, k: string, where: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length > MAX_LIST) fail('INVALID_FIELD', `${where}.${k}`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'string' || !ID_RE.test(x)) fail('INVALID_FIELD', `${where}.${k}[${i}]`);
    if (out.includes(x)) fail('DUPLICATE_ENTRY', `${where}.${k}[${i}]`);
    out.push(x);
  }
  return out;
}

const TARGET_KEYS = ['id', 'connectorId', 'label', 'kind', 'externalId', 'projectIds', 'allowedActorIds', 'canAnnotate', 'canRequestJpeg'] as const;
const INSTANCE_KEYS = ['id', 'kind', 'label', 'appId', 'secretEnv', 'tenantId', 'enabled', 'targets', 'creatorActorIds', 'creatorProjectIds'] as const;

function parseTarget(v: unknown, connectorId: string, where: string): ConnectorTarget {
  if (!isObj(v)) fail('INVALID_FIELD', where);
  only(v, TARGET_KEYS, where);
  const kind = v.kind;
  if (kind !== 'group' && kind !== 'user') fail('INVALID_FIELD', `${where}.kind`);
  const t: ConnectorTarget = {
    id: id(v, 'id', where), connectorId: id(v, 'connectorId', where), label: str(v, 'label', where),
    kind, externalId: id(v, 'externalId', where), projectIds: idList(v, 'projectIds', where),
    allowedActorIds: idList(v, 'allowedActorIds', where),
    canAnnotate: bool(v, 'canAnnotate', where), canRequestJpeg: bool(v, 'canRequestJpeg', where),
  };
  if (t.connectorId !== connectorId) fail('TARGET_CONNECTOR_MISMATCH', where);
  return t;
}

export function parseInstance(v: unknown, where = 'instance'): ConnectorInstanceConfig {
  rejectSecrets(v, where);
  if (!isObj(v)) fail('INVALID_FIELD', where);
  only(v, INSTANCE_KEYS, where);
  if (v.kind !== 'feishu') fail('INVALID_FIELD', `${where}.kind`);
  const cid = id(v, 'id', where);
  const secretEnv = str(v, 'secretEnv', where, 128);
  if (!ENV_RE.test(secretEnv)) fail('INVALID_SECRET_ENV', `${where}.secretEnv`);
  const tenantId = v.tenantId === null || v.tenantId === undefined ? null : id(v, 'tenantId', where);
  if (!Array.isArray(v.targets) || v.targets.length > MAX_TARGETS) fail('INVALID_FIELD', `${where}.targets`);
  const targets = v.targets.map((t, i) => parseTarget(t, cid, `${where}.targets[${i}]`));
  const seen = new Set<string>(); const seenExt = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.id)) fail('DUPLICATE_TARGET', t.id);
    const ext = `${t.kind}:${t.externalId}`;
    if (seenExt.has(ext)) fail('DUPLICATE_TARGET', ext);
    seen.add(t.id); seenExt.add(ext);
  }
  return {
    id: cid, kind: 'feishu', label: str(v, 'label', where), appId: id(v, 'appId', where), secretEnv, tenantId,
    enabled: v.enabled === undefined ? false : bool(v, 'enabled', where), targets,
    creatorActorIds: idList(v, 'creatorActorIds', where), creatorProjectIds: idList(v, 'creatorProjectIds', where),
  };
}

export function parseDocument(v: unknown): ConnectorConfigDocument {
  if (!isObj(v)) fail('INVALID_DOCUMENT');
  only(v, ['version', 'revision', 'instances'], 'document');
  if (v.version !== 1) fail('UNSUPPORTED_VERSION');
  const rev = v.revision;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) fail('INVALID_FIELD', 'document.revision');
  if (!Array.isArray(v.instances) || v.instances.length > MAX_INSTANCES) fail('INVALID_FIELD', 'document.instances');
  const instances = v.instances.map((x, i) => parseInstance(x, `instances[${i}]`));
  const ids = new Set<string>(); const apps = new Set<string>();
  for (const inst of instances) {
    if (ids.has(inst.id)) fail('DUPLICATE_INSTANCE', inst.id);
    if (apps.has(inst.appId)) fail('DUPLICATE_APP_ID', inst.appId);
    ids.add(inst.id); apps.add(inst.appId);
  }
  return deepFreeze({ version: 1, revision: rev, instances });
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}

export type SecretResolution =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly code: 'SECRET_ENV_MISSING' | 'SECRET_ENV_EMPTY' };

/** 私有运行时读取 Secret；调用方不得记录返回值。 */
export function resolveSecret(inst: ConnectorInstanceConfig, env: NodeJS.ProcessEnv = process.env): SecretResolution {
  if (!Object.hasOwn(env, inst.secretEnv)) return { ok: false, code: 'SECRET_ENV_MISSING' };
  const s = env[inst.secretEnv];
  if (!s) return { ok: false, code: 'SECRET_ENV_EMPTY' };
  return { ok: true, secret: s };
}

export function sanitize(inst: ConnectorInstanceConfig, env: NodeJS.ProcessEnv = process.env): SanitizedConnectorInstance {
  return { ...inst, secretConfigured: resolveSecret(inst, env).ok };
}

export interface ConfigStoreHooks {
  /** 测试注入：替换前调用，抛错模拟写入失败。 */
  readonly beforeRename?: (tmpPath: string) => void;
}

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * connectors.json 存储。单写者由 WriterGuard 在启用前保证（F08 装配）；
 * 本类保证原子替换与 revision 校验：写入失败不发布内存新状态，不丢旧文件。
 */
export class ConnectorConfigStore {
  readonly #file: string;
  readonly #dir: string;
  readonly #hooks: ConfigStoreHooks;
  #current: ConnectorConfigDocument;

  private constructor(dir: string, doc: ConnectorConfigDocument, hooks: ConfigStoreHooks) {
    this.#dir = dir; this.#file = path.join(dir, CONNECTORS_FILE); this.#current = doc; this.#hooks = hooks;
  }

  static open(dataDir: string, hooks: ConfigStoreHooks = {}): ConnectorConfigStore {
    const dir = fs.realpathSync(dataDir);
    const file = path.join(dir, CONNECTORS_FILE);
    let doc: ConnectorConfigDocument;
    let raw: Buffer | undefined;
    try { raw = fs.readFileSync(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (raw === undefined) doc = deepFreeze({ version: 1, revision: 0, instances: [] });
    else {
      if (raw.length > MAX_FILE_BYTES) fail('CONFIG_TOO_LARGE');
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { fail('CONFIG_CORRUPT'); }
      doc = parseDocument(parsed);
    }
    return new ConnectorConfigStore(dir, doc, hooks);
  }

  get current(): ConnectorConfigDocument { return this.#current; }

  list(env: NodeJS.ProcessEnv = process.env): SanitizedConnectorInstance[] {
    return this.#current.instances.map(i => sanitize(i, env));
  }

  /** 原子替换全部实例；expectedRevision 不符则 REVISION_CONFLICT。 */
  replace(instances: readonly unknown[], expectedRevision: number): ConnectorConfigDocument {
    if (expectedRevision !== this.#current.revision) fail('REVISION_CONFLICT');
    const next = parseDocument({ version: 1, revision: this.#current.revision + 1, instances });
    const body = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (body.length > MAX_FILE_BYTES) fail('CONFIG_TOO_LARGE');
    fs.chmodSync(this.#dir, 0o700);
    const tmp = path.join(this.#dir, `.${CONNECTORS_FILE}.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        let off = 0;
        while (off < body.length) off += fs.writeSync(fd, body, off);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.#hooks.beforeRename?.(tmp);
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    syncDir(this.#dir);
    this.#current = next;
    return next;
  }

  /** 新建实例：强制 enabled=false，appId/id 重复拒绝。 */
  create(input: unknown, expectedRevision: number): ConnectorConfigDocument {
    if (isObj(input) && 'enabled' in input && input.enabled !== false) fail('CREATE_MUST_BE_DISABLED');
    const inst = parseInstance(isObj(input) ? { ...input, enabled: false } : input);
    return this.replace([...this.#current.instances, inst], expectedRevision);
  }
}
