import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyStore, matchTargets, POLICIES_FILE } from '../src/delivery/policies.ts';
import { PreviewService, PREVIEW_TTL_MS } from '../src/delivery/previews.ts';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const tgt = (id, projectIds = ['p1'], label = id) => ({ id, label, projectIds });
const connectors = (over = {}) => ({ version: 1, revision: 3, instances: [
  { id: 'c1', enabled: true, targets: [tgt('g1'), tgt('g2')] },
  { id: 'c2', enabled: true, targets: [tgt('g3'), tgt('gx', ['p2'])] },
  { id: 'c3', enabled: false, targets: [tgt('g4')] },
], ...over });
const pol = (id, over = {}) => ({ id, enabled: true, projectIds: ['p1'], event: 'task.dispatched', targets: [], ...over });
const params = { alias: null, note: null, notifyOnComplete: false };

test('DP-02 匹配：项目+事件、去重、空 projectIds 不匹配、禁用不匹配', (t) => {
  const s = PolicyStore.open(tmp(t));
  const doc = s.replace([
    pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c2', targetId: 'g3' }] }),
    pol('b', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c1', targetId: 'g2' }] }),
    pol('c', { projectIds: [], targets: [{ connectorId: 'c9', targetId: 'z' }] }),
    pol('d', { enabled: false, targets: [{ connectorId: 'c9', targetId: 'y' }] }),
    pol('e', { event: 'task.completed', targets: [{ connectorId: 'c9', targetId: 'w' }] }),
  ], 0);
  assert.deepEqual(matchTargets(doc, 'p1', 'task.dispatched').map((x) => x.targetId), ['g1', 'g3', 'g2']);
  assert.deepEqual(matchTargets(doc, 'p1', 'task.completed').map((x) => x.targetId), ['w']);
  assert.deepEqual(matchTargets(doc, 'p2', 'task.dispatched'), []);
});

test('策略存储：原子、0600、revision 冲突、未知字段拒绝、重开一致、未改动策略保留 revision', (t) => {
  const dir = tmp(t);
  const s = PolicyStore.open(dir);
  s.replace([pol('a'), pol('b')], 0);
  assert.equal(fs.statSync(path.join(dir, POLICIES_FILE)).mode & 0o777, 0o600);
  assert.throws(() => s.replace([pol('a')], 0), { code: 'REVISION_CONFLICT' });
  assert.throws(() => s.replace([{ ...pol('a'), chatId: 'oc_x' }], 1), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => s.replace([pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1', path: '/x' }] })], 1), { code: 'UNKNOWN_FIELD' });
  const d2 = s.replace([pol('a'), pol('b', { enabled: false })], 1);
  assert.equal(d2.policies[0].revision, 1);
  assert.equal(d2.policies[1].revision, 2);
  assert.deepEqual(PolicyStore.open(dir).current, d2);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('DP-01/DP-05 预览：零发送、不可变、去重、过期、陈旧、取消、非法目标', (t) => {
  let now = 1_000_000;
  const svc = new PreviewService(() => now);
  const s = PolicyStore.open(tmp(t));
  s.replace([pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c3', targetId: 'g4' }] })], 0);
  let state = { connectors: connectors(), policies: s.current };

  const r = svc.create({ projectId: 'p1', photoIds: ['x2', 'x1', 'x1'], params }, state);
  assert.equal(r.ok, true);
  const p = r.preview;
  assert.deepEqual(p.photoIds, ['x1', 'x2']);
  assert.deepEqual(p.targets.map((x) => x.targetId), ['g1']);
  assert.ok(p.warnings.includes('POLICY_TARGET_UNAVAILABLE'));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.targets));
  assert.equal(Date.parse(p.expiresAt) - now, PREVIEW_TTL_MS);

  // 用户显式选择：去重；不在允许集合内拒绝（禁用实例 / 其他项目 / 未知）
  const sel = svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [{ connectorId: 'c2', targetId: 'g3' }, { connectorId: 'c2', targetId: 'g3' }] }, state);
  assert.equal(sel.preview.targets.length, 1);
  for (const bad of [{ connectorId: 'c3', targetId: 'g4' }, { connectorId: 'c2', targetId: 'gx' }, { connectorId: 'c1', targetId: 'nope' }]) {
    assert.equal(svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [bad] }, state).code, 'TARGET_NOT_ALLOWED');
  }
  const appOnly = svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [] }, state).preview;
  assert.deepEqual(appOnly.targets, []);
  assert.ok(appOnly.warnings.includes('NO_TARGET'));
  assert.equal(svc.create({ projectId: 'p1', photoIds: [], params }, state).code, 'EMPTY_SELECTION');

  assert.equal(svc.check(p.previewId, p.revision, state, ['x1', 'x2']).ok, true);
  assert.equal(svc.check(p.previewId, 'f'.repeat(64), state, ['x1', 'x2']).code, 'PREVIEW_REVISION_MISMATCH');
  assert.equal(svc.check(p.previewId, p.revision, state, ['x1']).detail, 'photos');
  const revoked = connectors({ instances: [{ id: 'c1', enabled: true, targets: [tgt('g1', ['p9'])] }] });
  assert.equal(svc.check(p.previewId, p.revision, { ...state, connectors: revoked }, ['x1', 'x2']).detail, 'target');
  s.replace([pol('a', { targets: [{ connectorId: 'c2', targetId: 'g3' }] })], 1);
  assert.equal(svc.check(p.previewId, p.revision, { ...state, policies: s.current }, ['x1', 'x2']).detail, 'policy');
  now += PREVIEW_TTL_MS;
  assert.equal(svc.check(p.previewId, p.revision, state, ['x1', 'x2']).code, 'PREVIEW_EXPIRED');
  assert.equal(svc.cancel(sel.preview.previewId), true);
  assert.equal(svc.check(sel.preview.previewId, sel.preview.revision, state, ['x1']).code, 'PREVIEW_NOT_FOUND');
  // 服务没有任何发送端口
  assert.equal(Object.getOwnPropertyNames(PreviewService.prototype).some((n) => /send|deliver/i.test(n)), false);
});

import { ConfirmationService, ConfirmationStore } from '../src/delivery/confirmations.ts';
import { DeliveryDispatcher } from '../src/delivery/dispatcher.ts';
import { DeliveryStore } from '../src/delivery/store.ts';
import { completionPartIndex, completionTargets } from '../src/delivery/completion.ts';
import { ConnectorConfigStore } from '../src/connectors/config.ts';
import { JobsService } from '../src/jobs/service.ts';
import { JobsStore } from '../src/core/jobs.ts';
import { OperationGates } from '../src/core/operation-gates.ts';

const proj = (op, stars) => ({ photoId: 'a', sourceOpId: op, by: 'u1', stars, del: false, channel: 'feishu', at: new Date().toISOString() });
async function completionHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-f29-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const connectors = ConnectorConfigStore.open(dir);
  const tg = (id) => ({ id, connectorId: 'c1', label: id, kind: 'group', externalId: `oc_${id}`, projectIds: ['p'], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false });
  connectors.create({ id: 'c1', kind: 'feishu', label: 'c1', appId: 'cli_c1', secretEnv: 'FF_X', tenantId: 't1', targets: [tg('g1'), tg('g2'), tg('g3')], creatorActorIds: [], creatorProjectIds: [] }, 0);
  connectors.replace(connectors.current.instances.map((i) => ({ ...i, enabled: true })), 1);
  const policies = PolicyStore.open(dir);
  const state = () => ({ connectors: connectors.current, policies: policies.current });
  const previews = new PreviewService();
  const sent = [];
  const confirmStore = ConfirmationStore.open(dir);
  const dispatcher = new DeliveryDispatcher({ store: DeliveryStore.open(dir), confirmations: confirmStore, state, transport: { send: async (r) => { sent.push({ targetId: r.targetId, kind: r.part.kind, partIndex: r.partIndex, intentId: r.intentId }); return { messageId: `om_${sent.length}` }; } } });
  let onDone = () => undefined;
  const gates = new OperationGates();
  const handler = { undoable: false, validate: () => [], plan: () => [], apply: () => ({ state: 'running' }) };
  const jobs = new JobsService(new JobsStore(dir), { annotate: handler }, { lib: { gates }, onDone: (j, g) => onDone(j.id, g) });
  const confirmations = new ConfirmationService(confirmStore, {
    previews, state, currentPhotoIds: (_p, ids) => ids,
    findJob: (id) => { try { return jobs.get(id); } catch { return undefined; } },
    jobOpen: (id) => !['cancelled', 'failed'].includes(jobs.get(id).state),
    createJob: (rec) => { try { return jobs.get(rec.jobId); } catch { return jobs.createConfirmed({ jobId: rec.jobId, requestId: rec.requestId, kind: 'annotate', selection: {}, params: {}, items: rec.snapshot.photoIds.map((id) => ({ id })), confirmationMode: 'explicit' }); } },
  });
  onDone = (id, g) => dispatcher.notifyCompleted(id, g);
  const P = { alias: 'A', note: null, notifyOnComplete: false };
  const create = (targets, notify, rid) => {
    const p = previews.create({ projectId: 'p', photoIds: ['a'], params: P, targets }, state()).preview;
    const r = confirmations.confirm({ previewId: p.previewId, revision: p.revision, requestId: rid, notifyOnComplete: notify, acknowledged: true });
    dispatcher.start(r.confirmation);
    return r.job.id;
  };
  const append = (jobId, targets, notify, rid) => {
    const p = previews.create({ projectId: 'p', photoIds: ['a'], params: P, targets, jobId }, state()).preview;
    const r = confirmations.confirmAppend({ jobId, previewId: p.previewId, revision: p.revision, requestId: rid, notifyOnComplete: notify, acknowledged: true });
    if (!r.replayed) dispatcher.startAppend(r.record);
    return r;
  };
  const waitRunning = async (id) => { for (let i = 0; i < 200 && jobs.get(id).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { dir, sent, jobs, dispatcher, confirmStore, policies, create, append, waitRunning };
}

test('F29 完成通知：仅确认时同意的目标；同代次重复事件/重标不重发；改策略不扩大范围', async (t) => {
  const h = await completionHarness(t);
  const jobId = h.create([{ connectorId: 'c1', targetId: 'g1' }], true, 'req_f29_base1');
  h.append(jobId, [{ connectorId: 'c1', targetId: 'g2' }], false, 'req_f29_app01'); // 追加但不要通知
  await h.dispatcher.idle(); await h.waitRunning(jobId);
  assert.deepEqual(h.sent.map((x) => [x.targetId, x.kind]), [['g1', 'task.dispatched'], ['g2', 'task.dispatched']]);
  // 之后加一条 task.completed 策略指向 g3：不应影响已确认任务
  h.policies.replace([{ id: 'late', enabled: true, projectIds: ['p'], event: 'task.completed', targets: [{ connectorId: 'c1', targetId: 'g3' }] }], h.policies.current.revision);
  await h.jobs.projectConfirmation(jobId, proj('op1', 3));
  assert.equal(h.jobs.get(jobId).state, 'done');
  await h.dispatcher.idle();
  const done = h.sent.filter((x) => x.kind === 'task.completed');
  assert.deepEqual(done.map((x) => x.targetId), ['g1'], '只通知确认时同意的 g1');
  assert.equal(done[0].partIndex, completionPartIndex(1));
  // 重复事件：同代次再次触发不重发；重标（任务已 done）也不触发
  h.dispatcher.notifyCompleted(jobId, 1);
  await h.jobs.projectConfirmation(jobId, proj('op2', 5)).catch(() => undefined);
  await h.dispatcher.idle();
  assert.equal(h.sent.filter((x) => x.kind === 'task.completed').length, 1);
  // 重启后同代次仍不重发（账本持久）
  const d2 = new DeliveryDispatcher({ store: DeliveryStore.open(h.dir), confirmations: ConfirmationStore.open(h.dir), state: () => ({ connectors: { instances: [], revision: 0 }, policies: h.policies.current }), transport: { send: async () => { throw new Error('不应发送'); } } });
  d2.notifyCompleted(jobId, 1); await d2.idle();
  // 新代次才是新通知
  h.dispatcher.notifyCompleted(jobId, 2); await h.dispatcher.idle();
  assert.equal(h.sent.filter((x) => x.kind === 'task.completed').length, 2);
});

test('F29 追加目标：绑定已有 jobId，任务/items/确认进度不变，只扩展目标投递记录', async (t) => {
  const h = await completionHarness(t);
  const jobId = h.create([{ connectorId: 'c1', targetId: 'g1' }], false, 'req_f29_base2');
  await h.dispatcher.idle(); await h.waitRunning(jobId);
  const before = JSON.stringify({ items: h.jobs.get(jobId).items, c: h.jobs.get(jobId).confirmation ?? null, n: h.jobs.list({}).length });
  const r = h.append(jobId, [{ connectorId: 'c1', targetId: 'g2' }, { connectorId: 'c1', targetId: 'g3' }], true, 'req_f29_app02');
  await h.dispatcher.idle();
  assert.equal(JSON.stringify({ items: h.jobs.get(jobId).items, c: h.jobs.get(jobId).confirmation ?? null, n: h.jobs.list({}).length }), before);
  assert.deepEqual(h.sent.map((x) => x.targetId), ['g1', 'g2', 'g3']);
  assert.throws(() => h.append(jobId, [{ connectorId: 'c1', targetId: 'g1' }], false, 'req_f29_app03'), /TARGET_ALREADY_IN_JOB|目标已在任务中/);
  // 通知目标 = 追加时勾选通知的 g2/g3（原确认未勾选 g1）
  assert.deepEqual(completionTargets(h.confirmStore.byJob(jobId), h.confirmStore.appendsOf(jobId)).map((x) => x.targetId), ['g2', 'g3']);
  assert.equal(r.record.jobId, jobId);
  // 取消后不能再追加
  await h.jobs.cancel(jobId);
  assert.equal(h.jobs.get(jobId).state, 'cancelled');
  assert.throws(() => h.append(jobId, [{ connectorId: 'c1', targetId: 'g3' }], false, 'req_f29_app04'), /JOB_CLOSED|已取消/);
});
