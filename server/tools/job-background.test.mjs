import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobsStore } from '../src/adapters/outbound/fs/jobs-store.ts';
import { JobsService } from '../src/application/jobs/service.ts';
import { OperationGates } from '../src/application/operation-gates.ts';

const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); assert.ok(fn(), '等待超时'); };

/** 假阶段型 handler：go 只受理；background 等闸门开了才逐张记 done */
function fakeHandler() {
  const gate = { open: null, wait: null, runs: 0 };
  gate.wait = new Promise((r) => { gate.open = r; });
  const handler = {
    undoable: false, validate: () => [], plan: () => [], apply: () => ({ state: 'running' }),
    actions: { go: (_job, _b, _c, sink) => { sink.patch({ phase: 'exporting' }); return { background: true }; } },
    background: async (job, _ctx, sink, signal) => {
      gate.runs++;
      await gate.wait;
      for (const it of job.items) {
        if (it.status !== 'planned' || signal.cancelled()) continue;
        sink.item(it.id, { status: 'done' });
      }
      return signal.cancelled() ? {} : { state: 'done', note: '后台完成' };
    },
  };
  return { gate, handler };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-bg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (handler) => new JobsService(new JobsStore(dir), { grade: handler }, { lib: { gates: new OperationGates() } });
}
const input = (id) => ({ jobId: id, requestId: `r_${id}`, kind: 'grade', selection: { ids: ['a', 'b'] }, params: {}, items: [{ id: 'a' }, { id: 'b' }] });

test('后台阶段：操作只受理（accepted），phase 置上；跑完清 phase、收尾 done', async (t) => {
  const mk = setup(t);
  const { gate, handler } = fakeHandler();
  const svc = mk(handler);
  svc.createConfirmed(input('j1'));
  await until(() => svc.get('j1').state === 'running');
  const r = await svc.action('j1', 'go', {});
  assert.equal(r.accepted, true);
  assert.equal(r.job.state, 'running');
  assert.equal(r.job.phase, 'exporting');
  gate.open();
  await until(() => svc.get('j1').state === 'done');
  assert.equal(svc.get('j1').phase, null);
  assert.deepEqual(svc.get('j1').items.map((i) => i.status), ['done', 'done']);
});

test('后台阶段：重启后 interrupted + phase 的任务被续跑', async (t) => {
  const mk = setup(t);
  const first = fakeHandler();
  const svc = mk(first.handler);
  svc.createConfirmed(input('j2'));
  await until(() => svc.get('j2').state === 'running');
  await svc.action('j2', 'go', {});
  await until(() => first.gate.runs === 1);
  // 「崩溃」：旧实例的后台永远不放行；新实例从磁盘读到 interrupted
  const second = fakeHandler();
  const svc2 = mk(second.handler);
  assert.equal(svc2.get('j2').state, 'interrupted');
  assert.equal(svc2.get('j2').phase, 'exporting');
  assert.deepEqual(svc2.resumeBackground(), ['j2']);
  second.gate.open();
  await until(() => svc2.get('j2').state === 'done');
  assert.equal(svc2.get('j2').phase, null);
});

test('后台阶段：跑的时候取消 —— 不再收尾，phase 清掉', async (t) => {
  const mk = setup(t);
  const { gate, handler } = fakeHandler();
  const svc = mk(handler);
  svc.createConfirmed(input('j3'));
  await until(() => svc.get('j3').state === 'running');
  await svc.action('j3', 'go', {});
  await until(() => gate.runs === 1);
  await svc.cancel('j3');
  gate.open();
  await until(() => svc.get('j3').phase === null);
  assert.equal(svc.get('j3').state, 'cancelled');
  assert.deepEqual(svc.get('j3').items.map((i) => i.status), ['planned', 'planned']);
});
