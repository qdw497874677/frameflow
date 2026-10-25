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

// ── F16：确认、投递查询与单目标重试（假传输，零真实发送）
import { ConfirmationService, ConfirmationStore } from '../src/delivery/confirmations.ts';
import { DeliveryDispatcher } from '../src/delivery/dispatcher.ts';
import { DeliveryStore } from '../src/delivery/store.ts';

async function setupF16(t, behave) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-f16-'));
  const connectors = ConnectorConfigStore.open(dir);
  const two = inst('c1');
  connectors.create({ ...two, targets: [...two.targets, { ...two.targets[0], id: 'g2', externalId: 'oc_g2', label: '二群' }, { ...two.targets[0], id: 'g3', externalId: 'oc_g3', label: '三群' }] }, 0);
  connectors.replace(connectors.current.instances.map((i) => ({ ...i, enabled: true })), 1);
  const policies = PolicyStore.open(dir);
  const previews = new PreviewService();
  const state = () => ({ connectors: connectors.current, policies: policies.current });
  const sent = [];
  const transport = { send: async (req) => { sent.push({ ...req }); return behave(req, sent.length); } };
  const confirmStore = ConfirmationStore.open(dir);
  const dispatcher = new DeliveryDispatcher({ store: DeliveryStore.open(dir), confirmations: confirmStore, transport, state, timeoutMs: 20 });
  const jobs = new Map();
  const confirmations = new ConfirmationService(confirmStore, {
    previews, state, currentPhotoIds: (_p, ids) => ids, findJob: (id) => jobs.get(id),
    createJob: (rec) => { if (!jobs.has(rec.jobId)) jobs.set(rec.jobId, { id: rec.jobId, state: 'queued' }); return jobs.get(rec.jobId); },
  });
  const app = Fastify();
  registerDeliveryRoutes(app, { policies, connectors, previews, confirmations, dispatcher, authEnabled: () => true, via: (req) => req.headers['x-test-via'] ?? 'session',
    projectExists: (id) => id === 'p', selectPhotos: () => ['a', 'b'] });
  await app.ready();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, url, payload, extra = {}) => app.inject({ method, url, payload, headers: { host: 'ff.local', origin: 'http://ff.local', ...extra } });
  return { call, sent, jobs, dispatcher, connectors, confirmStore };
}
const both = [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c1', targetId: 'g2' }];

test('F16 确认：受理状态稳定、重放 200、异载荷 409、仅应用内零发送', async (t) => {
  const { call, sent, jobs, dispatcher } = await setupF16(t, () => ({ messageId: 'om_1' }));
  const pv = (await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: both })).json();
  const body = { previewId: pv.previewId, revision: pv.revision, requestId: 'req_api_0001', notifyOnComplete: false, acknowledged: true };
  const r1 = await call('POST', '/api/v1/delivery-confirmations', body);
  assert.equal(r1.statusCode, 201);
  assert.equal(r1.json().job.state, 'queued');
  const r2 = await call('POST', '/api/v1/delivery-confirmations', body);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().job.id, r1.json().job.id);
  assert.equal((await call('POST', '/api/v1/delivery-confirmations', { ...body, notifyOnComplete: true })).json().code, 'REQUEST_ID_CONFLICT');
  await dispatcher.idle();
  assert.equal(sent.length, 2);
  assert.equal(jobs.size, 1);
  const text = JSON.stringify(sent) + (await call('GET', `/api/v1/jobs/${r1.json().job.id}/deliveries`)).body;
  assert.ok(!/FF_X|secret|\?t=|oc_/.test(text), '消息与 API 不含 Secret / 范围链接 / 外部 chat_id');
  const inApp = (await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [] })).json();
  const r3 = await call('POST', '/api/v1/delivery-confirmations', { previewId: inApp.previewId, revision: inApp.revision, requestId: 'req_api_0002' });
  assert.equal(r3.statusCode, 201);
  await dispatcher.idle();
  assert.equal(sent.length, 2);
  assert.equal((await call('GET', `/api/v1/jobs/${r3.json().job.id}/deliveries`)).json().items.length, 0);
});

test('F16 重试：只重发失败目标；unknown 需显式风险参数；停用时不调用发送', async (t) => {
  let mode = 'fail-g2';
  const { call, sent, dispatcher, connectors } = await setupF16(t, (req) => {
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'fail-g2' && req.targetId === 'g2') throw new Error('boom');
    return { messageId: `om_${req.targetId}` };
  });
  const pv = (await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: both })).json();
  const job = (await call('POST', '/api/v1/delivery-confirmations', { previewId: pv.previewId, revision: pv.revision, requestId: 'req_api_0003', acknowledged: true })).json().job;
  await dispatcher.idle();
  let items = (await call('GET', `/api/v1/jobs/${job.id}/deliveries`)).json().items;
  assert.deepEqual(items.map((i) => i.state), ['sent', 'failed']);
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g1' })).json().code, 'NOTHING_TO_RETRY');
  mode = 'hang';
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g2' })).statusCode, 202);
  await dispatcher.idle();
  items = (await call('GET', `/api/v1/jobs/${job.id}/deliveries`)).json().items;
  assert.equal(items[1].state, 'unknown');
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g2', acceptDuplicateRisk: true })).json().code, 'ATTEMPT_IN_FLIGHT');
  // 停用连接器：显式接受风险也不会调用传输
  connectors.replace(connectors.current.instances.map((i) => ({ ...i, enabled: false })), connectors.current.revision);
  const before = sent.length;
  dispatcher.runner.inFlight.clear();
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g2' })).json().code, 'DUPLICATE_RISK');
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g2', acceptDuplicateRisk: true })).statusCode, 202);
  await dispatcher.idle();
  assert.equal(sent.length, before);
  items = (await call('GET', `/api/v1/jobs/${job.id}/deliveries`)).json().items;
  assert.equal(items[1].error, 'AUTHORIZATION_REVOKED');
  assert.equal((await call('GET', '/api/v1/jobs/nope/deliveries')).statusCode, 404);
});

test('F29a 追加目标：绑定原 jobId、不建新任务；只发新目标；响应丢失重试仍关联原任务；异载荷/重叠/越权拒绝', async (t) => {
  const { call, sent, jobs, dispatcher, confirmStore } = await setupF16(t, (req) => ({ messageId: `om_${req.targetId}_${req.partIndex}` }));
  const pv = (await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [both[0]] })).json();
  const job = (await call('POST', '/api/v1/delivery-confirmations', { previewId: pv.previewId, revision: pv.revision, requestId: 'req_app_base1', acknowledged: true })).json().job;
  await dispatcher.idle();
  assert.equal(sent.length, 1);
  // 预览：零发送；已有目标不能"追加"（失败重试走 retry）
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-previews`, { targets: [both[0]] })).json().code, 'TARGET_ALREADY_IN_JOB');
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-previews`, { targets: [{ connectorId: 'c1', targetId: 'g2' }], projectId: 'x' })).json().code, 'UNKNOWN_FIELD');
  assert.equal((await call('POST', '/api/v1/jobs/nope/delivery-previews', { targets: [both[1]] })).statusCode, 404);
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-previews`, { targets: [{ connectorId: 'c2', targetId: 'g1' }] })).statusCode, 409, '未授权该项目的目标');
  const ap = await call('POST', `/api/v1/jobs/${job.id}/delivery-previews`, { targets: [both[1]] });
  assert.equal(ap.statusCode, 201);
  const apv = ap.json();
  assert.equal(apv.jobId, job.id); assert.deepEqual(apv.existingTargets.map((x) => x.targetId), ['g1']);
  assert.equal(sent.length, 1, '预览零发送');
  // 未确认外传 → 拒绝且零发送
  const body = { previewId: apv.previewId, revision: apv.revision, requestId: 'req_app_add01', notifyOnComplete: true, acknowledged: true };
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-appends`, { ...body, acknowledged: false })).json().code, 'CONSENT_REQUIRED');
  // 绑定到别的任务 → 拒绝
  const pv2 = (await call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: [] })).json();
  const other = (await call('POST', '/api/v1/delivery-confirmations', { previewId: pv2.previewId, revision: pv2.revision, requestId: 'req_app_other' })).json().job;
  assert.equal((await call('POST', `/api/v1/jobs/${other.id}/delivery-appends`, { ...body, requestId: 'req_app_x0001' })).json().code, 'PREVIEW_JOB_MISMATCH');
  const r1 = await call('POST', `/api/v1/jobs/${job.id}/delivery-appends`, body);
  assert.equal(r1.statusCode, 201, r1.body);
  await dispatcher.idle();
  assert.deepEqual(sent.map((x) => x.targetId), ['g1', 'g2'], '只给新目标发，旧成功目标不重发');
  // 响应丢失：同 requestId 重试 → 200 replayed，同一任务，不再发送
  const r2 = await call('POST', `/api/v1/jobs/${job.id}/delivery-appends`, body);
  assert.equal(r2.statusCode, 200); assert.equal(r2.json().replayed, true); assert.equal(r2.json().jobId, job.id);
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-appends`, { ...body, notifyOnComplete: false })).json().code, 'REQUEST_ID_CONFLICT');
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/delivery-appends`, { ...body, requestId: 'req_app_add02' })).json().code, 'PREVIEW_ALREADY_CONFIRMED');
  await dispatcher.idle();
  assert.equal(sent.length, 2);
  assert.equal(jobs.size, 2, '没有因为追加而新建任务');
  assert.deepEqual(confirmStore.targetsOf(job.id).map((x) => x.targetId), ['g1', 'g2']);
  // 追加目标失败后走单目标重试；重启后追加记录可读回
  assert.equal((await call('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g2' })).json().code, 'NOTHING_TO_RETRY');
  assert.equal(ConfirmationStore.open(path.dirname(confirmStore.file)).appendsOf(job.id).length, 1);
});

test('F29a 管理门：追加接口同样需要 session 与同源', async (t) => {
  const { call, sent } = await setupF16(t, () => ({ messageId: 'om' }));
  for (const url of ['/api/v1/jobs/j1/delivery-previews', '/api/v1/jobs/j1/delivery-appends']) {
    for (const extra of [{ 'x-test-via': 'token' }, { 'x-test-via': 'range' }, { origin: 'http://evil.example' }]) {
      const r = await call('POST', url, { targets: [] }, extra);
      assert.ok([401, 403].includes(r.statusCode), `${url} ${JSON.stringify(extra)} → ${r.statusCode}`);
    }
  }
  assert.equal(sent.length, 0);
});
