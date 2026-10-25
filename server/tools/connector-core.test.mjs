import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectorConfigStore, CONNECTORS_FILE, parseInstance, resolveSecret, sanitize } from '../src/connectors/config.ts';
import { decideAccess } from '../src/connectors/access.ts';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const target = (cid, over = {}) => ({
  id: 'g1', connectorId: cid, label: '修图群', kind: 'group', externalId: 'oc_group1',
  projectIds: ['p1'], allowedActorIds: ['ou_alice', 'ou_bob'], canAnnotate: true, canRequestJpeg: false, ...over,
});
const inst = (over = {}) => {
  const id = over.id ?? 'c1';
  return {
    id, kind: 'feishu', label: '飞书A', appId: `cli_${id}`, secretEnv: 'FF_SECRET_A', tenantId: 't1', enabled: false,
    targets: [target(id), target(id, { id: 'u1', kind: 'user', externalId: 'ou_carol', allowedActorIds: [], canRequestJpeg: true })],
    creatorActorIds: ['ou_alice', 'ou_carol'], creatorProjectIds: ['p1'], ...over,
  };
};

test('配置默认disabled、原子替换、0700/0600、重启恢复', t => {
  const dir = tmp(t);
  const store = ConnectorConfigStore.open(dir);
  assert.equal(store.current.revision, 0);
  const { enabled: _e, ...noEnabled } = inst();
  store.create(noEnabled, 0);
  assert.equal(store.current.instances[0].enabled, false);
  assert.throws(() => store.create(inst({ id: 'c2', enabled: true }), 1), /CREATE_MUST_BE_DISABLED/);
  assert.equal(fs.statSync(path.join(dir, CONNECTORS_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const reopened = ConnectorConfigStore.open(dir);
  assert.deepEqual(reopened.current, store.current);
  assert.ok(Object.isFrozen(reopened.current.instances[0].targets));
  assert.deepEqual(fs.readdirSync(dir), [CONNECTORS_FILE]);
});

test('revision冲突与写入失败不发布新状态、不丢旧文件', t => {
  const dir = tmp(t);
  const store = ConnectorConfigStore.open(dir);
  store.create(inst(), 0);
  const before = fs.readFileSync(path.join(dir, CONNECTORS_FILE), 'utf8');
  assert.throws(() => store.replace([inst({ label: '改' })], 0), /REVISION_CONFLICT/);
  const failing = ConnectorConfigStore.open(dir, { beforeRename: () => { throw new Error('EIO_INJECTED'); } });
  assert.throws(() => failing.replace([inst({ label: '改' })], 1), /EIO_INJECTED/);
  assert.equal(failing.current.revision, 1);
  assert.equal(failing.current.instances[0].label, '飞书A');
  assert.equal(fs.readFileSync(path.join(dir, CONNECTORS_FILE), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), [CONNECTORS_FILE]);
});

test('损坏/未知版本配置拒绝加载而不是回退为空或全开放', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, CONNECTORS_FILE), '{"version":1,"revision":1,"instances":[');
  assert.throws(() => ConnectorConfigStore.open(dir), /CONFIG_CORRUPT/);
  fs.writeFileSync(path.join(dir, CONNECTORS_FILE), JSON.stringify({ version: 2, revision: 1, instances: [] }));
  assert.throws(() => ConnectorConfigStore.open(dir), /UNSUPPORTED_VERSION/);
  fs.writeFileSync(path.join(dir, CONNECTORS_FILE), Buffer.from([0x7b, 0xff, 0x7d]));
  assert.throws(() => ConnectorConfigStore.open(dir), /CONFIG_CORRUPT/);
});

test('输入校验：原始Secret、非法环境变量名、重复appId/目标、未知字段均拒绝', t => {
  assert.throws(() => parseInstance({ ...inst(), appSecret: 'xxx' }), /RAW_SECRET_FORBIDDEN/);
  assert.throws(() => parseInstance({ ...inst(), targets: [{ ...target('c1'), secret: 'x' }] }), /RAW_SECRET_FORBIDDEN/);
  assert.throws(() => parseInstance(inst({ secretEnv: 'lower-case' })), /INVALID_SECRET_ENV/);
  assert.throws(() => parseInstance({ ...inst(), extra: 1 }), /UNKNOWN_FIELD/);
  assert.throws(() => parseInstance(inst({ targets: [target('c1'), target('c1')] })), /DUPLICATE_TARGET/);
  assert.throws(() => parseInstance(inst({ targets: [target('other')] })), /TARGET_CONNECTOR_MISMATCH/);
  assert.throws(() => parseInstance(inst({ creatorProjectIds: ['../etc'] })), /INVALID_FIELD/);
  const dirStore = ConnectorConfigStore.open(tmp(t));
  assert.throws(() => dirStore.replace([inst(), inst({ id: 'c2', appId: 'cli_c1' })], 0), /DUPLICATE_APP_ID/);
  assert.throws(() => dirStore.replace([inst(), inst()], 0), /DUPLICATE_INSTANCE/);
});

test('Secret只从环境读取并脱敏，配置/列表不含值', t => {
  const dir = tmp(t);
  const store = ConnectorConfigStore.open(dir);
  store.create(inst(), 0);
  const env = { FF_SECRET_A: 's3cr3t-value' };
  const [view] = store.list(env);
  assert.equal(view.secretConfigured, true);
  assert.ok(!JSON.stringify(view).includes('s3cr3t-value'));
  assert.ok(!fs.readFileSync(path.join(dir, CONNECTORS_FILE), 'utf8').includes('s3cr3t-value'));
  assert.equal(sanitize(store.current.instances[0], {}).secretConfigured, false);
  assert.deepEqual(resolveSecret(store.current.instances[0], {}), { ok: false, code: 'SECRET_ENV_MISSING' });
  assert.deepEqual(resolveSecret(store.current.instances[0], { FF_SECRET_A: '' }), { ok: false, code: 'SECRET_ENV_EMPTY' });
  assert.deepEqual(resolveSecret(store.current.instances[0], env), { ok: true, secret: 's3cr3t-value' });
});

test('通用类型不引入飞书SDK', () => {
  for (const f of ['types.ts', 'config.ts', 'access.ts']) {
    const src = fs.readFileSync(new URL(`../src/connectors/${f}`, import.meta.url), 'utf8');
    assert.ok(!/larksuite|lark|feishu\//i.test(src.replace(/'feishu'/g, '')), f);
  }
});

function doc(over = {}) {
  return { version: 1, revision: 1, instances: [parseInstance(inst({ enabled: true, ...over })), parseInstance(inst({ id: 'c2', tenantId: 't2', enabled: true, secretEnv: 'FF_SECRET_B' }))] };
}
const group = { kind: 'group', externalId: 'oc_group1' };
const dm = { kind: 'user', externalId: 'ou_carol' };
const who = (actorId, connectorId = 'c1', tenantId = 't1') => ({ connectorId, tenantId, actorId });
const task = { projectId: 'p1', taskDeliveredTargetIds: ['g1', 'u1'], photo: { inTaskSnapshot: true, accessible: true } };
const reason = d => (d.allowed ? 'ALLOWED' : d.reason);

test('跨实例/租户/来源/用户身份矩阵默认拒绝', () => {
  const d = doc();
  const base = { connectorId: 'c1', operation: 'help' };
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice'), source: group })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_carol'), source: dm })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...base, connectorId: 'nope', identity: who('ou_alice'), source: group })), 'CONNECTOR_NOT_FOUND');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice', 'c2', 't2'), source: group })), 'IDENTITY_CONNECTOR_MISMATCH');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice', 'c1', 't2'), source: group })), 'TENANT_MISMATCH');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice'), source: null })), 'SOURCE_MISSING');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice'), source: { kind: 'group', externalId: 'oc_other' } })), 'TARGET_NOT_CONFIGURED');
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_mallory'), source: group })), 'ACTOR_NOT_ALLOWED');
  // 私聊：转发给他人的卡片不扩权
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_alice'), source: dm })), 'ACTOR_NOT_ALLOWED');
  // 群与私聊 kind 不混用
  assert.equal(reason(decideAccess(d, { ...base, identity: who('ou_carol'), source: { kind: 'group', externalId: 'ou_carol' } })), 'TARGET_NOT_CONFIGURED');
  const disabled = doc({ enabled: false });
  assert.equal(reason(decideAccess(disabled, { ...base, identity: who('ou_alice'), source: group })), 'CONNECTOR_DISABLED');
  const noTenant = doc({ tenantId: null });
  assert.equal(reason(decideAccess(noTenant, { ...base, identity: who('ou_alice'), source: group })), 'TENANT_UNKNOWN');
});

test('创建权限独立：无需已有任务，但须创建者+允许项目', () => {
  const d = doc();
  const c = { connectorId: 'c1', operation: 'create', source: group };
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_alice'), projectId: 'p1' })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_bob'), projectId: 'p1' })), 'NOT_CREATOR');
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_alice') })), 'PROJECT_REQUIRED');
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_alice'), projectId: 'p2' })), 'PROJECT_NOT_ALLOWED');
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_alice'), projectId: 'p1', extraTargetIds: ['u1'] })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...c, identity: who('ou_alice'), projectId: 'p1', extraTargetIds: ['zz'] })), 'EXTRA_TARGET_NOT_ALLOWED');
});

test('canAnnotate/canRequestJpeg 独立且任务须投递给该目标', () => {
  const d = doc();
  const g = { connectorId: 'c1', identity: who('ou_bob'), source: group, ...task };
  const u = { connectorId: 'c1', identity: who('ou_carol'), source: dm, ...task };
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate' })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'requestJpeg' })), 'JPEG_DENIED');
  assert.equal(reason(decideAccess(d, { ...u, operation: 'requestJpeg' })), 'ALLOWED');
  const noAnnot = doc({ targets: [target('c1', { canAnnotate: false })] });
  assert.equal(reason(decideAccess(noAnnot, { ...g, operation: 'annotate' })), 'ANNOTATE_DENIED');
  assert.equal(reason(decideAccess(noAnnot, { ...g, operation: 'viewTask' })), 'ALLOWED');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', taskDeliveredTargetIds: undefined })), 'TASK_REQUIRED');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', taskDeliveredTargetIds: ['u1'] })), 'TASK_NOT_DELIVERED');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', projectId: 'p9' })), 'PROJECT_NOT_ALLOWED');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', photo: undefined })), 'PHOTO_NOT_IN_TASK');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', photo: { inTaskSnapshot: false, accessible: true } })), 'PHOTO_NOT_IN_TASK');
  assert.equal(reason(decideAccess(d, { ...g, operation: 'annotate', photo: { inTaskSnapshot: true, accessible: false } })), 'PHOTO_UNAVAILABLE');
  // 执行时复验：撤销 allowlist 后旧卡立即失效
  const revoked = doc({ targets: [target('c1', { allowedActorIds: ['ou_alice'] })] });
  assert.equal(reason(decideAccess(revoked, { ...g, operation: 'annotate' })), 'ACTOR_NOT_ALLOWED');
});
