import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreviewService } from '../src/application/delivery/previews.ts';
import { ConfirmationService } from '../src/application/delivery/confirmation-service.ts';
import { ConfirmationStore } from '../src/adapters/outbound/fs/delivery-confirmations.ts';

const target = { id: 'g1', connectorId: 'c1', label: '群', kind: 'group', externalId: 'oc_x', projectIds: ['p'], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false };
const conn = (enabled = true) => ({ version: 1, revision: 1, instances: [{ id: 'c1', kind: 'feishu', enabled, label: 'c', appId: 'cli', secretEnv: 'FF_X', tenantId: 't', targets: [target], creatorActorIds: [], creatorProjectIds: [] }] });
const pol = { version: 1, revision: 1, policies: [] };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const env = { connectors: conn(), policies: pol, jobs: new Map(), creates: 0, failCreate: false };
  const previews = new PreviewService(() => clock);
  const mk = () => new ConfirmationService(ConfirmationStore.open(dir), {
    previews, state: () => ({ connectors: env.connectors, policies: env.policies }),
    currentPhotoIds: (_p, ids) => ids,
    findJob: (id) => env.jobs.get(id),
    createJob: (rec) => {
      if (env.failCreate) throw new Error('crash');
      if (!env.jobs.has(rec.jobId)) { env.creates++; env.jobs.set(rec.jobId, { id: rec.jobId, requestId: rec.requestId }); }
      return env.jobs.get(rec.jobId);
    },
  }, () => clock);
  const preview = (targets) => previews.create({ projectId: 'p', photoIds: ['a', 'b'], params: { alias: null, note: null, notifyOnComplete: false }, targets }, { connectors: env.connectors, policies: env.policies }).preview;
  return { env, mk, preview, tick: (ms) => { clock += ms; } };
}
const inp = (p, over = {}) => ({ previewId: p.previewId, revision: p.revision, requestId: 'req_00000001', notifyOnComplete: true, acknowledged: true, ...over });

test('确认：需外传同意；接受后重放同任务；异载荷/换 requestId 拒绝', (t) => {
  const { env, mk, preview } = setup(t);
  const svc = mk();
  const p = preview([{ connectorId: 'c1', targetId: 'g1' }]);
  assert.throws(() => svc.confirm(inp(p, { acknowledged: false })), (e) => e.code === 'CONSENT_REQUIRED');
  assert.throws(() => svc.confirm(inp(p, { requestId: 'x' })), (e) => e.code === 'INVALID');
  const r1 = svc.confirm(inp(p));
  assert.equal(r1.replayed, false);
  assert.equal(r1.confirmation.snapshot.params.notifyOnComplete, true);
  const r2 = svc.confirm(inp(p));
  assert.equal(r2.job.id, r1.job.id);
  assert.equal(r2.replayed, true);
  assert.throws(() => svc.confirm(inp(p, { notifyOnComplete: false })), (e) => e.code === 'REQUEST_ID_CONFLICT');
  assert.throws(() => svc.confirm(inp(p, { requestId: 'req_00000002' })), (e) => e.code === 'PREVIEW_ALREADY_CONFIRMED');
  assert.equal(env.creates, 1);
});

test('仅应用内也走 requestId；过期后重试命中已接受记录；未接受的过期预览拒绝', (t) => {
  const { env, mk, preview, tick } = setup(t);
  const svc = mk();
  const inApp = preview([]);
  const a = svc.confirm(inp(inApp, { acknowledged: false }));
  tick(11 * 60 * 1000);
  assert.equal(svc.confirm(inp(inApp, { acknowledged: false })).job.id, a.job.id, '过期后重试仍返回原任务');
  const late = preview([]);
  tick(11 * 60 * 1000);
  assert.throws(() => svc.confirm(inp(late, { requestId: 'req_late0001' })), (e) => e.code === 'PREVIEW_EXPIRED');
  assert.equal(env.creates, 1);
});

test('并发双确认只建一个任务', async (t) => {
  const { env, mk, preview } = setup(t);
  const svc = mk();
  const p = preview([{ connectorId: 'c1', targetId: 'g1' }]);
  const rs = await Promise.allSettled([1, 2, 3].map(() => Promise.resolve().then(() => svc.confirm(inp(p)))));
  assert.ok(rs.every((r) => r.status === 'fulfilled'));
  assert.equal(new Set(rs.map((r) => r.value.job.id)).size, 1);
  assert.equal(env.creates, 1);
});

test('崩溃于记录后建任务前：重启恢复补建；授权撤销则中止不建', (t) => {
  const { env, mk, preview } = setup(t);
  env.failCreate = true;
  const p1 = preview([{ connectorId: 'c1', targetId: 'g1' }]);
  const p2 = preview([{ connectorId: 'c1', targetId: 'g1' }]);
  assert.throws(() => mk().confirm(inp(p1)), /crash/);
  assert.throws(() => mk().confirm(inp(p2, { requestId: 'req_00000002' })), /crash/);
  env.failCreate = false;
  // 重启：恢复 → 两个都补建
  assert.deepEqual(mk().recover(), { recovered: 2, aborted: 0 });
  assert.equal(env.creates, 2);
  // 再造一个崩溃中的确认，然后撤销授权
  env.failCreate = true;
  const p3 = preview([{ connectorId: 'c1', targetId: 'g1' }]);
  assert.throws(() => mk().confirm(inp(p3, { requestId: 'req_00000003' })), /crash/);
  env.failCreate = false;
  env.connectors = conn(false);
  const svc = mk();
  assert.deepEqual(svc.recover(), { recovered: 2, aborted: 1 }, '已建任务照常返回，未建且被撤销的中止');
  assert.throws(() => svc.confirm(inp(p3, { requestId: 'req_00000003' })), (e) => e.code === 'AUTHORIZATION_REVOKED');
  assert.equal(env.creates, 2);
});
