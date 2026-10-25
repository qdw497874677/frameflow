import test from 'node:test';
import assert from 'node:assert/strict';
import { jobActions } from './jobActions.ts';

test('Bug 11：已取消任务不给取消/链接；撤销后进度归零', () => {
  const cancelled = jobActions({ state: 'cancelled', reversible: true, progress: { done: 4, total: 20 } } as never, false);
  assert.equal(cancelled.canCancel, false);
  assert.equal(cancelled.linkUsable, false);
  assert.equal(cancelled.canUndo, true, '取消前写下的标注仍可撤销');
  const undone = jobActions({ state: 'cancelled', reversible: true, progress: { done: 4, total: 20 } } as never, true);
  assert.equal(undone.canUndo, false);
  assert.equal(undone.progress.percent, 0);
  assert.match(undone.progress.label, /已撤销（原进度 4\/20）/);
  const running = jobActions({ state: 'dispatched', reversible: false, progress: { done: 1, total: 4 } } as never, false);
  assert.deepEqual([running.canCancel, running.linkUsable, running.canUndo, running.progress.percent], [true, true, false, 25]);
});
