import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectorConfigStore } from '../src/connectors/config.ts';
import { ConnectorRegistry } from '../src/connectors/registry.ts';
import { ConnectorRuntime, WRITER_LOCK } from '../src/connectors/runtime.ts';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const target = (cid, id = 'g1') => ({ id, connectorId: cid, label: '群', kind: 'group', externalId: `oc_${cid}_${id}`, projectIds: ['p1'], allowedActorIds: ['ou_a'], canAnnotate: true, canRequestJpeg: false });
const inst = (id, over = {}) => ({ id, kind: 'feishu', label: id, appId: `cli_${id}`, secretEnv: `FF_${id.toUpperCase()}`, tenantId: 't1', enabled: false, targets: [target(id)], creatorActorIds: [], creatorProjectIds: [], ...over });
const ENV = { FF_C1: 'fake-secret-1', FF_C2: 'fake-secret-2' };

function fakes() {
  const calls = [];
  const ports = new Map();
  const factory = (cfg, secret) => {
    const port = {
      handler: null,
      async start(h) { calls.push(['start', cfg.id]); this.handler = h; },
      async stop() { calls.push(['stop', cfg.id]); },
      async send(i) { calls.push(['send', cfg.id, i.targetId]); return { status: 'sent', messageId: `m_${calls.length}` }; },
      async update(i) { calls.push(['update', cfg.id, i.messageId]); return { status: 'sent', messageId: i.messageId }; },
      async verify() { calls.push(['verify', cfg.id]); return secret.startsWith('fake') ? { ok: true } : { ok: false, code: 'BAD_CREDENTIAL' }; },
    };
    ports.set(cfg.id, port);
    return port;
  };
  return { calls, ports, factory };
}
function setup(t, env = ENV) {
  const dir = tmp(t);
  const store = ConnectorConfigStore.open(dir);
  store.replace([inst('c1'), inst('c2')], 0);
  const reg = new ConnectorRegistry();
  const f = fakes();
  reg.register('feishu', f.factory);
  const events = [];
  const rt = new ConnectorRuntime(store, reg, dir, async (id, ev) => { events.push([id, ev]); return { kind: 'accepted' }; }, env);
  t.after(() => rt.stopAll());
  return { dir, store, reg, rt, f, events };
}
const enable = (store, ids) => store.replace(store.current.instances.map(i => ({ ...i, enabled: ids.includes(i.id) })), store.current.revision);

test('未启用零连接；两实例独立启停', async t => {
  const { store, rt, f } = setup(t);
  await rt.sync();
  assert.deepEqual(f.calls, []);
  assert.equal(rt.status('c1').state, 'disabled');
  enable(store, ['c1', 'c2']);
  await rt.sync();
  assert.equal(rt.status('c1').state, 'connected');
  assert.equal(rt.status('c2').state, 'connected');
  enable(store, ['c2']);
  await rt.sync();
  assert.deepEqual(f.calls.filter(c => c[0] === 'stop'), [['stop', 'c1']]);
  assert.equal(rt.status('c1').state, 'disabled');
  assert.equal(rt.status('c2').state, 'connected');
});

test('同 appId 启用被拒绝', t => {
  const { store } = setup(t);
  assert.throws(() => store.replace([inst('c1', { enabled: true }), inst('c2', { appId: 'cli_c1', enabled: true })], store.current.revision), /appId|DUPLICATE/i);
});

test('坏环境引用可诊断且不泄露；重启状态不假装 connected', async t => {
  const { store, rt, reg, dir, f } = setup(t, { FF_C2: '' });
  enable(store, ['c1', 'c2']);
  await rt.sync();
  assert.deepEqual(rt.status('c1'), { state: 'error', reason: 'SECRET_ENV_MISSING' });
  assert.deepEqual(rt.status('c2'), { state: 'error', reason: 'SECRET_ENV_EMPTY' });
  assert.equal(f.calls.length, 0);
  const reg2 = new ConnectorRegistry();
  const rt2 = new ConnectorRuntime(ConnectorConfigStore.open(dir), reg2, dir, async () => ({ kind: 'accepted' }), ENV);
  assert.equal(rt2.status('c1').state, 'disabled');
  await rt.stopAll();
});

test('单写者保护在启动前生效', async t => {
  const { store, rt, dir, f } = setup(t);
  fs.writeFileSync(path.join(dir, WRITER_LOCK), String(process.ppid));
  enable(store, ['c1']);
  await rt.sync();
  assert.deepEqual(rt.status('c1'), { state: 'error', reason: 'SINGLE_WRITER_LOCKED' });
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(path.join(dir, WRITER_LOCK), '999999999'); // 残留锁可接管
  await rt.sync();
  assert.equal(rt.status('c1').state, 'connected');
});

test('测试连接不发消息；执行前再授权，停用阻止外传', async t => {
  const { store, rt, f } = setup(t);
  assert.deepEqual(await rt.test('c1'), { ok: true });
  assert.deepEqual(f.calls, [['verify', 'c1']]);
  enable(store, ['c1']);
  await rt.sync();
  const content = { type: 'test-card' };
  assert.equal((await rt.send('c1', { targetId: 'g1', intentId: 'i1', content })).status, 'sent');
  assert.deepEqual(f.calls.at(-1), ['send', 'c1', 'g1']);
  assert.equal((await rt.send('c1', { targetId: 'nope', intentId: 'i2', content })).code, 'TARGET_REVOKED');
  // 排队后停用（配置已改、尚未 sync）：执行时刻也拒绝
  enable(store, []);
  assert.equal((await rt.send('c1', { targetId: 'g1', intentId: 'i3', content })).code, 'CONNECTOR_DISABLED');
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
});

test('停用后事件拒绝；跨实例身份拒绝', async t => {
  const { store, rt, f, events } = setup(t);
  enable(store, ['c1']);
  await rt.sync();
  const h = f.ports.get('c1').handler;
  const ev = (cid) => ({ identity: { connectorId: cid, tenantId: 't1', actorId: 'ou_a' }, source: null, payload: {} });
  assert.equal((await h(ev('c1'))).kind, 'accepted');
  assert.equal((await h(ev('c2'))).code, 'CONNECTOR_MISMATCH');
  enable(store, []);
  assert.equal((await h(ev('c1'))).code, 'CONNECTOR_DISABLED');
  assert.equal(events.length, 1);
});
