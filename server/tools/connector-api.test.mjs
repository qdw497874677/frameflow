import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ConnectorConfigStore } from '../src/connectors/config.ts';
import { ConnectorRegistry } from '../src/connectors/registry.ts';
import { ConnectorRuntime } from '../src/connectors/runtime.ts';
import { registerConnectorRoutes } from '../src/api/connectors.ts';

const SECRET = 'fake-secret-value-xyz';
const ENV = { FF_C1: SECRET };
const inst = (id = 'c1', over = {}) => ({ id, kind: 'feishu', label: id, appId: `cli_${id}`, secretEnv: 'FF_C1', tenantId: 't1',
  targets: [{ id: 'g1', connectorId: id, label: '群', kind: 'group', externalId: `oc_${id}`, projectIds: ['p'], allowedActorIds: ['ou_a'], canAnnotate: true, canRequestJpeg: false }],
  creatorActorIds: [], creatorProjectIds: [], ...over });

async function setup(t, { authEnabled = true, referenced = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-api-'));
  const store = ConnectorConfigStore.open(dir);
  const reg = new ConnectorRegistry();
  const calls = [];
  reg.register('feishu', (cfg) => ({
    async start() { calls.push('start'); }, async stop() { calls.push('stop'); },
    async send() { calls.push('send'); return { status: 'sent', messageId: 'm' }; },
    async update() { calls.push('update'); return { status: 'sent', messageId: 'm' }; },
    async verify() { calls.push('verify'); return { ok: true }; },
  }));
  const runtime = new ConnectorRuntime(store, reg, dir, async () => ({ kind: 'accepted' }), ENV);
  const app = Fastify();
  registerConnectorRoutes(app, { store, runtime, env: ENV, authEnabled: () => authEnabled, via: (req) => req.headers['x-test-via'] ?? 'disabled', isReferenced: () => referenced });
  await app.ready();
  t.after(async () => { await app.close(); await runtime.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, url, payload, via = 'session', extra = {}) =>
    app.inject({ method, url, payload, headers: { 'x-test-via': via, host: 'ff.local', origin: 'http://ff.local', ...extra } });
  return { app, store, calls, call };
}
const noSecret = (res) => assert.ok(!res.body.includes(SECRET), 'response leaked secret');

test('增删改查、分页、revision 冲突、无消息测试', async t => {
  const { call, calls } = await setup(t);
  let r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst('c1') });
  assert.equal(r.statusCode, 201); noSecret(r);
  assert.equal(r.json().item.secretConfigured, true);
  assert.equal(r.json().item.enabled, false);
  r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst('c2', { appId: 'cli_c2' }) });
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'REVISION_CONFLICT');
  await call('POST', '/api/v1/connectors', { expectedRevision: 1, instance: inst('c2') });
  r = await call('GET', '/api/v1/connectors?limit=1');
  assert.equal(r.json().items.length, 1); assert.equal(r.json().nextCursor, '1'); noSecret(r);
  r = await call('GET', '/api/v1/connectors?limit=1&cursor=1');
  assert.equal(r.json().items[0].id, 'c2'); assert.equal(r.json().nextCursor, null);
  assert.equal((await call('GET', '/api/v1/connectors?limit=0')).statusCode, 400);
  r = await call('PATCH', '/api/v1/connectors/c1', { expectedRevision: 2, patch: { enabled: true } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().item.status.state, 'connected'); noSecret(r);
  r = await call('POST', '/api/v1/connectors/c1/test');
  assert.deepEqual(r.json(), { ok: true });
  assert.ok(!calls.includes('send') && !calls.includes('update'));
  r = await call('GET', '/api/v1/connectors/c1/targets');
  assert.equal(r.json().items[0].id, 'g1');
  r = await call('DELETE', '/api/v1/connectors/c1?expectedRevision=3');
  assert.equal(r.json().code, 'CONNECTOR_ENABLED');
  await call('PATCH', '/api/v1/connectors/c1', { expectedRevision: 3, patch: { enabled: false } });
  assert.equal((await call('DELETE', '/api/v1/connectors/c1?expectedRevision=4')).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/connectors/c1/targets')).statusCode, 404);
  assert.equal((await call('PATCH', '/api/v1/connectors/zz', { expectedRevision: 5, patch: {} })).statusCode, 404);
});

test('被引用删除 409', async t => {
  const { call } = await setup(t, { referenced: true });
  await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst() });
  const r = await call('DELETE', '/api/v1/connectors/c1?expectedRevision=1');
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'CONNECTOR_REFERENCED');
});

test('只放管理 session；未设密码不可用；跨站拒绝；原始 Secret 拒绝', async t => {
  const { call, store } = await setup(t);
  for (const via of ['bearer', 'link', 'annotate', 'disabled']) {
    const r = await call('GET', '/api/v1/connectors', undefined, via);
    assert.equal(r.statusCode, 403); assert.equal(r.json().code, 'SESSION_REQUIRED');
  }
  let r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst() }, 'session', { origin: 'http://evil.example' });
  assert.equal(r.json().code, 'CSRF_REJECTED');
  r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst() }, 'session', { origin: '' });
  assert.equal(r.json().code, 'CSRF_REJECTED');
  r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: { ...inst(), appSecret: SECRET } });
  assert.equal(r.statusCode, 400); assert.equal(r.json().code, 'RAW_SECRET_FORBIDDEN'); noSecret(r);
  r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst() });
  r = await call('PATCH', '/api/v1/connectors/c1', { expectedRevision: 1, patch: { secret: SECRET } });
  assert.equal(r.json().code, 'RAW_SECRET_FORBIDDEN'); noSecret(r);
  assert.equal(store.current.revision, 1);
});

test('未设应用密码时不能管理或启用', async t => {
  const { call, store } = await setup(t, { authEnabled: false });
  const r = await call('POST', '/api/v1/connectors', { expectedRevision: 0, instance: inst() }, 'disabled');
  assert.equal(r.statusCode, 403); assert.equal(r.json().code, 'PASSWORD_REQUIRED');
  assert.equal(store.current.instances.length, 0);
});
