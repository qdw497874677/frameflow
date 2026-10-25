import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ConnectorConfigStore } from '../src/connectors/config.ts';
import { PolicyStore } from '../src/delivery/policies.ts';
import { PreviewService } from '../src/delivery/previews.ts';
import { registerDeliveryRoutes } from '../src/api/delivery.ts';

const inst = (id, projectIds = ['p']) => ({ id, kind: 'feishu', label: id, appId: `cli_${id}`, secretEnv: 'FF_X', tenantId: 't1',
  targets: [{ id: 'g1', connectorId: id, label: `${id}群`, kind: 'group', externalId: `oc_${id}`, projectIds, allowedActorIds: [], canAnnotate: false, canRequestJpeg: false }],
  creatorActorIds: [], creatorProjectIds: [] });

async function setup(t, { authEnabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-api-'));
  const connectors = ConnectorConfigStore.open(dir);
  connectors.create(inst('c1'), 0);
  connectors.create(inst('c2', ['other']), 1);
  // 让 c1 启用（只改配置，不连真实平台）
  connectors.replace(connectors.current.instances.map((i) => (i.id === 'c1' ? { ...i, enabled: true } : i)), 2);
  const policies = PolicyStore.open(dir);
  const sent = [];
  const previews = new PreviewService();
  const app = Fastify();
  registerDeliveryRoutes(app, {
    policies, connectors, previews, authEnabled: () => authEnabled, via: (req) => req.headers['x-test-via'] ?? 'disabled',
    projectExists: (id) => id === 'p', selectPhotos: (pid, sel) => (sel.ids ?? ['a', 'b']).filter((x) => x !== 'other'),
  });
  await app.ready();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, url, payload, via = 'session', extra = {}) =>
    app.inject({ method, url, payload, headers: { 'x-test-via': via, host: 'ff.local', origin: 'http://ff.local', ...extra } });
  return { call, policies, connectors, sent };
}
const pol = (over = {}) => ({ id: 'r1', enabled: true, projectIds: ['p'], event: 'task.dispatched', targets: [{ connectorId: 'c1', targetId: 'g1' }], ...over });

test('策略 CRUD：revision、引用校验、分页、外部 chat_id/路径拒绝', async (t) => {
  const { call } = await setup(t);
  let r = await call('POST', '/api/v1/delivery-policies', { expectedRevision: 0, policy: pol() });
  assert.equal(r.statusCode, 201); assert.equal(r.json().policy.revision, 1);
  r = await call('POST', '/api/v1/delivery-policies', { expectedRevision: 0, policy: pol({ id: 'r2' }) });
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'REVISION_CONFLICT');
  assert.equal((await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: pol() })).json().code, 'POLICY_EXISTS');
  r = await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: pol({ id: 'r2', targets: [{ connectorId: 'c2', targetId: 'g1' }] }) });
  assert.equal(r.json().code, 'TARGET_PROJECT_NOT_ALLOWED');
  r = await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: pol({ id: 'r2', targets: [{ connectorId: 'c9', targetId: 'g1' }] }) });
  assert.equal(r.json().code, 'TARGET_NOT_FOUND');
  r = await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: pol({ id: 'r2', targets: [{ connectorId: 'c1', targetId: 'g1', chat_id: 'oc_evil' }] }) });
  assert.equal(r.json().code, 'UNKNOWN_FIELD'); assert.ok(!r.body.includes('oc_evil'));
  assert.equal((await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: { ...pol({ id: 'r3' }), path: '/etc' } })).json().code, 'UNKNOWN_FIELD');
  await call('POST', '/api/v1/delivery-policies', { expectedRevision: 1, policy: pol({ id: 'r2', event: 'task.completed' }) });
  r = await call('GET', '/api/v1/delivery-policies?limit=1');
  assert.equal(r.json().items.length, 1); assert.equal(r.json().nextCursor, '1');
  assert.equal((await call('GET', '/api/v1/delivery-policies?limit=101')).statusCode, 400);
  r = await call('PATCH', '/api/v1/delivery-policies/r1', { expectedRevision: 2, patch: { enabled: false } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().policy.enabled, false); assert.equal(r.json().policy.revision, 3);
  assert.equal((await call('PATCH', '/api/v1/delivery-policies/r1', { expectedRevision: 3, patch: { id: 'x' } })).json().code, 'UNKNOWN_FIELD');
  assert.equal((await call('PATCH', '/api/v1/delivery-policies/r1', { expectedRevision: 1, patch: { enabled: true } })).statusCode, 409);
  assert.equal((await call('DELETE', '/api/v1/delivery-policies/r1?expectedRevision=3')).statusCode, 200);
  assert.equal((await call('GET', '/api/v1/delivery-policies')).json().items.length, 1);
  assert.equal((await call('POST', '/api/v1/delivery-policies', { expectedRevision: 4, policy: { ...pol({ id: 'big' }), projectIds: Array.from({ length: 300 }, (_, i) => `p${i}`) } })).statusCode, 400);
});

test('预览/取消零发送；目标需在允许集合；任意外部字段拒绝', async (t) => {
  const { call, sent } = await setup(t);
  await call('POST', '/api/v1/delivery-policies', { expectedRevision: 0, policy: pol() });
  let r = await call('POST', '/api/v1/delivery-previews', { projectId: 'p', selection: {} });
  assert.equal(r.statusCode, 201);
  const pv = r.json();
  assert.equal(pv.photoCount, 2); assert.deepEqual(pv.targets, [{ connectorId: 'c1', targetId: 'g1', label: 'c1群' }]);
  assert.match(pv.revision, /^[0-9a-f]{64}$/); assert.ok(Date.parse(pv.expiresAt) > Date.now());
  assert.ok(!r.body.includes('oc_c1'), '预览不暴露外部 chat id');
  r = await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [{ connectorId: 'c2', targetId: 'g1' }] });
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'TARGET_NOT_ALLOWED');
  assert.equal((await call('POST', '/api/v1/delivery-previews', { projectId: 'p', chatId: 'oc_evil' })).json().code, 'UNKNOWN_FIELD');
  assert.equal((await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [{ connectorId: 'c1', targetId: 'g1', externalId: 'oc_x' }] })).json().code, 'UNKNOWN_FIELD');
  assert.equal((await call('POST', '/api/v1/delivery-previews', { projectId: '../etc' })).json().code, 'PROJECT_NOT_FOUND');
  assert.equal((await call('POST', '/api/v1/delivery-previews', { projectId: 'p', selection: { ids: ['other'] } })).json().code, 'EMPTY_SELECTION');
  assert.equal((await call('POST', '/api/v1/delivery-previews', { projectId: 'p', params: { alias: 'x'.repeat(501) } })).json().code, 'INVALID_PARAMS');
  r = await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [] });
  assert.deepEqual(r.json().targets, []); assert.ok(r.json().warnings.includes('NO_TARGET'));
  assert.equal((await call('DELETE', `/api/v1/delivery-previews/${pv.previewId}`)).statusCode, 204);
  assert.equal((await call('DELETE', `/api/v1/delivery-previews/${pv.previewId}`)).statusCode, 404);
  assert.deepEqual(sent, []);
});

test('管理门：无密码 / 非 session / 跨站 一律拒绝', async (t) => {
  const a = await setup(t, { authEnabled: false });
  assert.equal((await a.call('GET', '/api/v1/delivery-policies')).json().code, 'PASSWORD_REQUIRED');
  const b = await setup(t);
  assert.equal((await b.call('GET', '/api/v1/delivery-policies', undefined, 'bearer')).json().code, 'SESSION_REQUIRED');
  assert.equal((await b.call('POST', '/api/v1/delivery-previews', { projectId: 'p' }, 'link')).json().code, 'SESSION_REQUIRED');
  assert.equal((await b.call('POST', '/api/v1/delivery-previews', { projectId: 'p' }, 'session', { origin: 'http://evil.example' })).json().code, 'CSRF_REJECTED');
});
