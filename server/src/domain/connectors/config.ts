/** 连接器实例配置的校验（拒绝密钥字段、限制规模）与密钥引用解析。落盘见 adapters/outbound/fs/connector-config-store.ts。 */
import type {
  ConnectorConfigDocument, ConnectorInstanceConfig, ConnectorTarget, SanitizedConnectorInstance,
} from './types.ts';

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

export const EMPTY_CONNECTOR_DOCUMENT: ConnectorConfigDocument = deepFreeze({ version: 1, revision: 0, instances: [] });

/** 只读的环境变量视图（由适配层传入，domain 不读 process） */
export type SecretEnv = Readonly<Record<string, string | undefined>>;

export type SecretResolution =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly code: 'SECRET_ENV_MISSING' | 'SECRET_ENV_EMPTY' };

/** 私有运行时读取 Secret；调用方不得记录返回值。 */
export function resolveSecret(inst: ConnectorInstanceConfig, env: SecretEnv): SecretResolution {
  if (!Object.hasOwn(env, inst.secretEnv)) return { ok: false, code: 'SECRET_ENV_MISSING' };
  const s = env[inst.secretEnv];
  if (!s) return { ok: false, code: 'SECRET_ENV_EMPTY' };
  return { ok: true, secret: s };
}

export function sanitize(inst: ConnectorInstanceConfig, env: SecretEnv): SanitizedConnectorInstance {
  return { ...inst, secretConfigured: resolveSecret(inst, env).ok };
}

/** 新建实例：强制 enabled=false（显式要求启用即拒绝） */
export function parseNewInstance(input: unknown): ConnectorInstanceConfig {
  if (isObj(input) && 'enabled' in input && input.enabled !== false) fail('CREATE_MUST_BE_DISABLED');
  return parseInstance(isObj(input) ? { ...input, enabled: false } : input);
}
