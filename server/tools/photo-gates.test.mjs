import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationGates } from '../src/application/operation-gates.ts';

const P = OperationGates.photo;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('同一照片串行：后写不会被先写覆盖（XMP 有序）', async () => {
  const g = new OperationGates();
  const xmp = [];
  const a = g.run([P('x')], async () => { await sleep(30); xmp.push('old'); });
  const b = g.run([P('x')], async () => { xmp.push('new'); });
  await Promise.all([a, b]);
  assert.deepEqual(xmp, ['old', 'new']);
});

test('慢挂载的照片不阻塞其它照片', async () => {
  const g = new OperationGates();
  let release;
  const slow = g.run([P('slow')], () => new Promise((r) => { release = r; }));
  const t0 = Date.now();
  await g.run([P('fast')], () => 'ok');
  assert.ok(Date.now() - t0 < 50);
  release();
  await slow;
});

test('已持锁内部方法可重入，不死锁', async () => {
  const g = new OperationGates();
  const out = await g.run([P('a'), P('b')], () => g.run([P('a')], () => g.run([P('b'), P('a')], () => 42)));
  assert.equal(out, 42);
});

test('多照片批次按排序加锁，交叉批次不死锁', async () => {
  const g = new OperationGates();
  const runs = [];
  for (let i = 0; i < 50; i++) {
    const keys = i % 2 ? [P('a'), P('b'), P('c')] : [P('c'), P('a')];
    runs.push(g.run(keys, async () => { await sleep(1); return i; }));
  }
  const res = await Promise.race([Promise.all(runs), sleep(3000).then(() => 'timeout')]);
  assert.notEqual(res, 'timeout');
});

test('失败释放锁并能诊断，后续写继续', async () => {
  const g = new OperationGates();
  await assert.rejects(g.run([P('x')], () => { throw new Error('XMP_WRITE_FAILED'); }), /XMP_WRITE_FAILED/);
  assert.equal(await g.run([P('x')], () => 'next'), 'next');
  assert.equal(g.held().size, 0);
});
