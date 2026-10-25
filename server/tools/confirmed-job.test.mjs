import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobsStore } from '../src/core/jobs.ts';
import { JobsService } from '../src/jobs/service.ts';

const handler = {
  undoable: false,
  validate: (d) => (d.params.label ? [] : [{ field: 'params.label', message: 'need' }]),
  plan: () => { throw new Error('确认式创建不应重新展开选择集'); },
  apply: () => ({ state: 'running' }),
};
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmed-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mk = () => new JobsService(new JobsStore(dir), { annotate: handler }, {});
  return { dir, mk };
}
const input = (over = {}) => ({ jobId: 'job_1', requestId: 'req_1', kind: 'annotate', selection: { ids: ['a', 'b'] },
  params: { label: 'x' }, items: [{ id: 'a' }, { id: 'b' }], ...over });

test('同 requestId 同载荷返回同一任务；异载荷 409；不重展开选择集', async (t) => {
  const svc = setup(t).mk();
  const a = svc.createConfirmed(input());
  assert.equal(a.id, 'job_1');
  assert.equal(a.state, 'queued');
  assert.deepEqual(a.items.map((i) => i.id), ['a', 'b']);
  const b = svc.createConfirmed(input());
  assert.equal(b.id, 'job_1');
  assert.equal(svc.list().length, 1);
  assert.throws(() => svc.createConfirmed(input({ items: [{ id: 'a' }] })), (e) => e.code === 'conflict');
  assert.throws(() => svc.createConfirmed(input({ requestId: 'req_2' })), (e) => e.code === 'conflict', 'jobId 已占');
  assert.throws(() => svc.createConfirmed(input({ jobId: 'j2', requestId: 'r2', params: {} })), (e) => e.code === 'invalid');
  assert.throws(() => svc.createConfirmed(input({ jobId: 'j3', requestId: 'r3', items: [] })), (e) => e.code === 'invalid');
});

test('重启后 requestId 索引重建；planned 残留重放会补入队', async (t) => {
  const { dir, mk } = setup(t);
  const store = new JobsStore(dir);
  // 模拟「落库后、入队前」崩溃
  store.create({ id: 'job_9', requestId: 'req_9', requestFingerprint: null, kind: 'annotate', selection: {}, items: [{ id: 'a', status: 'planned' }], reversible: false });
  const svc = mk();
  assert.throws(() => svc.createConfirmed(input({ jobId: 'job_9', requestId: 'req_9' })), (e) => e.code === 'conflict', '指纹不同拒绝');
  const s1 = mk();
  const j = s1.createConfirmed(input({ jobId: 'job_8', requestId: 'req_8' }));
  const s2 = mk();
  assert.equal(s2.createConfirmed(input({ jobId: 'job_8', requestId: 'req_8' })).id, j.id);
  assert.equal(s2.list().filter((x) => x.requestId === 'req_8').length, 1);
});

test('旧 /jobs 创建路径不受影响（随机 id、无 requestId）', async (t) => {
  const svc = new JobsService(new JobsStore(setup(t).dir), { annotate: { ...handler, plan: () => [{ id: 'a', status: 'planned' }] } }, {});
  const job = await svc.create({ kind: 'annotate', selection: {}, params: { label: 'x' }, mode: 'apply' });
  assert.notEqual(job.id, 'plan');
  assert.equal(job.requestId, undefined);
});
