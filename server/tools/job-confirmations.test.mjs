import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobsStore } from '../src/adapters/outbound/fs/jobs-store.ts';
import { confirmationSummary } from '../src/domain/jobs/job.ts';
import { JobsService } from '../src/application/jobs/service.ts';
import { OperationGates } from '../src/application/operation-gates.ts';

const handler = { undoable: false, validate: () => [], plan: () => [], apply: () => ({ state: 'running' }) };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-confirm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, mk: () => new JobsService(new JobsStore(dir), { annotate: handler }, { lib: { gates: new OperationGates() } }) };
}
const input = { jobId: 'job_c', requestId: 'req_c', kind: 'annotate', selection: { ids: ['a', 'b'] }, params: {},
  items: [{ id: 'a' }, { id: 'b' }], confirmationMode: 'explicit' };
const proj = (photoId, op, stars = 3) => ({ photoId, sourceOpId: op, by: 'u1', stars, del: false, channel: 'feishu', at: '2026-10-25T00:00:00Z' });
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('F23 明确确认：首次计数、重标不计数、同 sourceOpId 幂等、全部确认后 done', async (t) => {
  const { mk } = setup(t);
  const svc = mk();
  svc.createConfirmed(input);
  await until(() => svc.get('job_c').state === 'running');
  assert.equal(svc.get('job_c').confirmationMode, 'explicit');
  const r1 = await svc.projectConfirmation('job_c', proj('a', 'op1'));
  assert.equal(r1.replayed, false);
  assert.equal((await svc.projectConfirmation('job_c', proj('a', 'op1'))).replayed, true);
  await svc.projectConfirmation('job_c', proj('a', 'op2', 5));
  let s = confirmationSummary(svc.get('job_c'), (id) => ['a','b'].includes(id));
  assert.equal(s.confirmed, 1); assert.equal(s.remaining, 1);
  const a = svc.get('job_c').items.find((i) => i.id === 'a');
  assert.equal(a.stars, 5); assert.equal(a.sourceOpId, 'op2'); assert.equal(a.confirmedBy, 'u1');
  s = confirmationSummary(svc.get('job_c'), (id) => id === 'a');
  assert.equal(s.blocked, 1); assert.equal(s.total, 2, '无权项不减分母');
  await svc.projectConfirmation('job_c', proj('b', 'op3'));
  assert.equal(svc.get('job_c').state, 'done');
  // done 后受控重标：不加数，状态仍 done
  await svc.projectConfirmation('job_c', proj('b', 'op4', 1));
  assert.equal(svc.get('job_c').state, 'done');
  assert.equal(confirmationSummary(svc.get('job_c'), (id) => ['a','b'].includes(id)).confirmed, 2);
  // 重启：投影集合从事件重建
  const s2 = mk();
  assert.equal(s2.hasProjected('job_c', 'op3'), true);
  assert.equal((await s2.projectConfirmation('job_c', proj('b', 'op3'))).replayed, true);
});

test('F23 非 explicit 任务拒绝投影；旧指纹不变', async (t) => {
  const svc = setup(t).mk();
  svc.createConfirmed({ ...input, jobId: 'j_old', requestId: 'r_old', confirmationMode: undefined });
  await until(() => svc.get('j_old').state === 'running' || svc.get('j_old').state === 'done');
  await assert.rejects(svc.projectConfirmation('j_old', proj('a', 'x')), (e) => e.code === 'invalid' || e.code === 'conflict');
  assert.throws(() => svc.createConfirmed({ ...input, jobId: 'j_old', requestId: 'r_old' }), (e) => e.code === 'conflict', '模式不同=载荷不同');
});

test('F23 提交后投影前崩溃：对账只补投影一次', async (t) => {
  const { reconcileConfirmations } = await import('../src/application/jobs/confirmations.ts');
  const { mk } = setup(t);
  const svc = mk();
  svc.createConfirmed({ ...input, jobId: 'job_r', requestId: 'req_r' });
  await until(() => svc.get('job_r').state === 'running');
  const ops = [{ opId: 'opX', confirmation: { jobId: 'job_r', photoId: 'a', actorId: 'u2', at: '2026-10-25T01:00:00Z' }, result: { opId: 'opX', revisions: {}, results: [{ id: 'a', ok: true, stars: 4, del: false, error: null }] } }];
  const deps = { confirmedOps: () => ops, hasProjected: (j, o) => svc.hasProjected(j, o), projectConfirmation: (j, p) => svc.projectConfirmation(j, p), get: (j) => svc.get(j) };
  assert.equal(await reconcileConfirmations(deps, 'job_r'), 1);
  assert.equal(await reconcileConfirmations(deps, 'job_r'), 0);
  const a = svc.get('job_r').items.find((i) => i.id === 'a');
  assert.equal(a.stars, 4); assert.equal(a.confirmedBy, 'u2');
  assert.equal(svc.get('job_r').events?.filter?.((e) => e.sourceOpId === 'opX')?.length ?? 1, 1);
});
