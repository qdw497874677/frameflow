import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryStore } from '../src/delivery/store.ts';
import { DeliveryRunner, UnknownOutcome } from '../src/delivery/runner.ts';

/** 可控假传输：按 (target, part) 指定行为；记录每次调用 */
function fakeTransport() {
  const calls = [];
  const plan = new Map();
  return {
    calls, plan,
    send(req) {
      calls.push(`${req.targetId}#${req.partIndex}`);
      const b = plan.get(`${req.targetId}#${req.partIndex}`)?.shift() ?? 'ok';
      if (b === 'ok') return Promise.resolve({ messageId: `om_${calls.length}` });
      if (b === 'fail') return Promise.reject(new Error('boom'));
      return b; // 自定义 promise（挂起/迟到）
    },
  };
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const T = [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c1', targetId: 'g2' }];

test('先写意图再发送；只重试失败分片；目标间隔离', async (t) => {
  const dir = setup(t);
  const store = DeliveryStore.open(dir);
  const tr = fakeTransport();
  tr.plan.set('g1#1', ['fail']);
  const seenSending = [];
  const transport = { send: (req) => { seenSending.push(store.intentState(req, req.intentId)); return tr.send(req); } };
  const runner = new DeliveryRunner({ store, transport, authorized: () => true });
  let v = await runner.run({ jobId: 'j', targets: T, parts: ['p0', 'p1', 'p2'] });
  assert.ok(seenSending.every((s) => s === 'sending'), '传输被调用时意图已落盘');
  assert.deepEqual(v.map((x) => `${x.targetId}#${x.partIndex}:${x.state}`), ['g1#0:sent', 'g1#1:failed', 'g1#2:pending', 'g2#0:sent', 'g2#1:sent', 'g2#2:sent']);
  tr.calls.length = 0;
  v = await runner.run({ jobId: 'j', targets: T, parts: ['p0', 'p1', 'p2'] });
  assert.deepEqual(tr.calls, ['g1#1', 'g1#2']);
  assert.ok(v.every((x) => x.state === 'sent'));
  assert.equal(v.find((x) => x.targetId === 'g1' && x.partIndex === 1).attempts, 2);
});

test('残留 sending 重启收敛为 unknown，且不自动重发', async (t) => {
  const dir = setup(t);
  const s1 = DeliveryStore.open(dir);
  const key = { jobId: 'j', connectorId: 'c1', targetId: 'g1', partIndex: 0 };
  s1.ensure(key);
  s1.beginIntent(key); // 模拟发送中被杀
  const s2 = DeliveryStore.open(dir);
  assert.equal(s2.view(key).state, 'unknown');
  const tr = fakeTransport();
  await new DeliveryRunner({ store: s2, transport: tr, authorized: () => true }).run({ jobId: 'j', targets: [T[0]], parts: ['p0'] });
  assert.deepEqual(tr.calls, []);
});

test('超时判 unknown；迟到成功归属原意图', async (t) => {
  const dir = setup(t);
  const store = DeliveryStore.open(dir);
  const tr = fakeTransport();
  let resolveLate;
  tr.plan.set('g1#0', [new Promise((r) => { resolveLate = r; })]);
  const runner = new DeliveryRunner({ store, transport: tr, authorized: () => true, timeoutMs: 10 });
  let v = await runner.run({ jobId: 'j', targets: [T[0]], parts: ['p0'] });
  assert.equal(v[0].state, 'unknown');
  const intent = v[0].currentIntentId;
  resolveLate({ messageId: 'om_late' });
  await Promise.all([...runner.late]);
  v = DeliveryStore.open(dir).listJob('j');
  assert.equal(v[0].state, 'sent');
  assert.equal(v[0].messageId, 'om_late');
  assert.equal(v[0].currentIntentId, intent);
  assert.equal(v[0].attempts, 1);
});

test('发送前复核授权：撤销即 failed，不调传输', async (t) => {
  const store = DeliveryStore.open(setup(t));
  const tr = fakeTransport();
  const v = await new DeliveryRunner({ store, transport: tr, authorized: (x) => x.targetId !== 'g1' }).run({ jobId: 'j', targets: T, parts: ['p0'] });
  assert.deepEqual(tr.calls, ['g2#0']);
  assert.equal(v[0].error, 'AUTHORIZATION_REVOKED');
});

test('F21 传输明确报告 unknown：记 unknown，不自动重发', async (t) => {
  const dir = setup(t);
  const store = DeliveryStore.open(dir);
  let n = 0;
  const runner = new DeliveryRunner({ store, transport: { send: async () => { n++; throw new UnknownOutcome('TIMEOUT'); } }, authorized: () => true });
  let v = await runner.run({ jobId: 'j', targets: [T[0]], parts: ['p0'] });
  assert.equal(v[0].state, 'unknown');
  v = await runner.run({ jobId: 'j', targets: [T[0]], parts: ['p0'] });
  assert.equal(v[0].state, 'unknown');
  assert.equal(n, 1);
});

test('F29 partOffset：完成通知分片独立序号段，不与派发分片混账', async (t) => {
  const { DeliveryRunner } = await import('../src/delivery/runner.ts');
  const { DeliveryStore } = await import('../src/delivery/store.ts');
  const fsm = await import('node:fs'); const osm = await import('node:os'); const pm = await import('node:path');
  const dir = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'runner-off-'));
  t.after(() => fsm.rmSync(dir, { recursive: true, force: true }));
  const store = DeliveryStore.open(dir);
  const seen = [];
  const r = new DeliveryRunner({ store, authorized: () => true, transport: { send: async (q) => { seen.push(q.partIndex); return { messageId: `m${q.partIndex}` }; } } });
  const tg = [{ connectorId: 'c', targetId: 'g' }];
  await r.run({ jobId: 'j', targets: tg, parts: ['entry'] });
  await r.run({ jobId: 'j', targets: tg, parts: ['done'], partOffset: 1001 });
  await r.run({ jobId: 'j', targets: tg, parts: ['done'], partOffset: 1001 });
  assert.deepEqual(seen, [0, 1001]);
  assert.deepEqual(store.listJob('j').map((v) => [v.partIndex, v.state]), [[0, 'sent'], [1001, 'sent']]);
});
