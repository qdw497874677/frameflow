import test from 'node:test';
import assert from 'node:assert/strict';
import { listCounts } from './counts.ts';

test('Bug 10：总数不含被藏起来的待删（3 张里 1 张待删 → 第 x / 2 张）', () => {
  assert.deepEqual(listCounts({ loaded: 2, pageTotal: 2, folderCount: 3, showingDeleted: false }), { total: 2, hiddenDeleted: 1 });
  assert.deepEqual(listCounts({ loaded: 1, pageTotal: 1, folderCount: 3, showingDeleted: true }), { total: 1, hiddenDeleted: 0 });
  assert.deepEqual(listCounts({ loaded: 200, pageTotal: 450, folderCount: 450, showingDeleted: false }), { total: 450, hiddenDeleted: 0 }, '分页时总数仍是全量');
});
