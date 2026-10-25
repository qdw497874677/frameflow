import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperationGates } from '../src/core/operation-gates.ts';

const J = OperationGates.job, P = OperationGates.photo;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('job → photo 顺序允许；持 photo 锁再取 job 锁立即报错', async () => {
  const g = new OperationGates();
  assert.equal(await g.run([J('j')], () => g.run([P('x')], () => 'ok')), 'ok');
  await assert.rejects(g.run([P('x')], () => g.run([J('j')], () => 'no')), /GATE_ORDER_VIOLATION/);
});

test('cancel/undo/inbound 竞争：锁内复核终态，只撤销一次', async () => {
  const g = new OperationGates();
  const state = { s: 'running', undone: false, undos: 0 };
  const undo = () => g.run([J('j')], async () => {
    if (state.undone) throw new Error('已经撤销过了');
    await g.run([P('x')], () => sleep(5));
    state.undone = true; state.undos++; state.s = 'cancelled';
  });
  const cancel = () => g.run([J('j')], () => {
    if (state.s !== 'running') throw new Error('取消不了');
    state.s = 'cancelled';
  });
  const res = await Promise.allSettled([undo(), cancel(), undo(), cancel()]);
  assert.equal(state.undos, 1);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
});

test('普通标记（只取 photo）与任务操作并发无死锁', async () => {
  const g = new OperationGates();
  const ops = [];
  for (let i = 0; i < 40; i++) {
    ops.push(i % 2 ? g.run([J('j')], () => g.run([P('a'), P('b')], () => sleep(1))) : g.run([P('b'), P('a')], () => sleep(1)));
  }
  const r = await Promise.race([Promise.all(ops), sleep(3000).then(() => 'timeout')]);
  assert.notEqual(r, 'timeout');
});
