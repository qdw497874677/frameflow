import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectorConfigStore } from '../src/adapters/outbound/fs/connector-config-store.ts';
import { ConnectorRegistry } from '../src/application/connectors/registry.ts';
import { ConnectorRuntime } from '../src/application/connectors/runtime.ts';
import { PidFileLock, WRITER_LOCK } from '../src/adapters/outbound/fs/writer-lock.ts';

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
  const rt = new ConnectorRuntime(store, reg, new PidFileLock(dir), async (id, ev) => { events.push([id, ev]); return { kind: 'accepted' }; }, env);
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
  const rt2 = new ConnectorRuntime(ConnectorConfigStore.open(dir), reg2, new PidFileLock(dir), async () => ({ kind: 'accepted' }), ENV);
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

// ── F21：飞书适配器经运行时（假 SDK，零网络）
import Fastify from 'fastify';
import { feishuFactory } from '../src/adapters/feishu/transport.ts';
import { registerConnectorRoutes } from '../src/adapters/inbound/http/connectors.ts';

function feishuSetup(t) {
  const dir = tmp(t);
  const store = ConnectorConfigStore.open(dir);
  store.replace([inst('c1'), inst('c2')], 0);
  const n = { api: 0, ws: 0, start: 0, close: 0, create: [] };
  const sdk = {
    api() { n.api++; return {
      createMessage: async (r) => { n.create.push(r); return { code: 0, data: { message_id: 'om_x' } }; },
      patchMessage: async () => ({ code: 0 }), uploadImage: async () => ({ code: 0, data: { image_key: 'i' } }),
      uploadFile: async () => ({ code: 0, data: { file_key: 'f' } }), verifyToken: async () => ({ code: 0 }) }; },
    longConnection() { n.ws++; return { start: async () => { n.start++; }, close: () => { n.close++; } }; },
  };
  const reg = new ConnectorRegistry();
  reg.register('feishu', feishuFactory({ sdk: () => sdk }));
  const rt = new ConnectorRuntime(store, reg, new PidFileLock(dir), async () => ({ kind: 'rejected', code: 'NO_HANDLER' }), ENV);
  t.after(() => rt.stopAll());
  return { store, rt, n };
}

test('F21 飞书工厂：未启用零 SDK 调用；启用只建一条长连接；stopAll 关闭', async t => {
  const { store, rt, n } = feishuSetup(t);
  await rt.sync();
  assert.deepEqual([n.api, n.ws, n.start], [0, 0, 0]);
  enable(store, ['c1']);
  await rt.sync();
  assert.equal(n.start, 1);
  assert.equal(rt.status('c1').state, 'connected');
  const r = await rt.send('c1', { targetId: 'g1', intentId: 'i1', content: { type: 'test-card' } });
  assert.equal(r.status, 'sent');
  assert.equal(n.create[0].receiveId, 'oc_c1_g1');
  assert.equal((await rt.send('c2', { targetId: 'g1', intentId: 'i2', content: { type: 'test-card' } })).status, 'failed');
  await rt.stopAll();
  assert.equal(n.close, 1);
});

test('F21 测试卡 API：须确认、只发已授权目标、须启用', async t => {
  const { store, rt, n } = feishuSetup(t);
  store.replace(store.current.instances.map((i) => i.id === 'c1' ? { ...i, targets: [...i.targets, { ...target('c1', 'g2'), projectIds: [] }] } : i), store.current.revision);
  const app = Fastify();
  registerConnectorRoutes(app, { store, runtime: rt, env: ENV, authEnabled: () => true, via: (req) => req.headers['x-test-via'] ?? 'disabled' });
  await app.ready();
  t.after(() => app.close());
  const call = (payload, via = 'session') => app.inject({ method: 'POST', url: '/api/v1/connectors/c1/test-card', payload, headers: { 'x-test-via': via, host: 'h', origin: 'http://h' } });
  assert.equal((await call({ targetId: 'g1', confirm: true }, 'bearer')).statusCode, 403);
  assert.equal((await call({ targetId: 'g1' })).json().code, 'CONFIRM_REQUIRED');
  assert.equal((await call({ targetId: 'g1', confirm: true })).json().code, 'CONNECTOR_DISABLED');
  enable(store, ['c1']);
  await rt.sync();
  assert.equal((await call({ targetId: 'nope', confirm: true })).json().code, 'TARGET_NOT_FOUND');
  assert.equal((await call({ targetId: 'g2', confirm: true })).json().code, 'TARGET_NOT_AUTHORIZED');
  assert.equal(n.create.length, 0);
  const ok = await call({ targetId: 'g1', confirm: true });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().result.status, 'sent');
  assert.equal(n.create.length, 1);
});
