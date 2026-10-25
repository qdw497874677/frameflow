import test from 'node:test';
import assert from 'node:assert/strict';
import { listCounts } from './counts.ts';

test('Bug 10：总数不含被藏起来的待删（3 张里 1 张待删 → 第 x / 2 张）', () => {
  assert.deepEqual(listCounts({ loaded: 2, pageTotal: 2, deletedInFolder: 1, showingDeleted: false }), { total: 2, hiddenDeleted: 1 });
  assert.deepEqual(listCounts({ loaded: 1, pageTotal: 1, deletedInFolder: 1, showingDeleted: true }), { total: 1, hiddenDeleted: 0 });
  assert.deepEqual(listCounts({ loaded: 200, pageTotal: 450, deletedInFolder: 0, showingDeleted: false }), { total: 450, hiddenDeleted: 0 }, '分页时总数仍是全量');
});

test('侧边栏口径：筛选让列表变短时，不把被筛掉的误报成「待删未显示」', () => {
  // 目录 10 张（1 张待删），星级筛选后只剩 3 张：隐藏的待删仍是 1，而不是 10-3
  assert.deepEqual(listCounts({ loaded: 3, pageTotal: 3, deletedInFolder: 1, showingDeleted: false }), { total: 3, hiddenDeleted: 1 });
  assert.deepEqual(listCounts({ loaded: 3, showingDeleted: false }), { total: 3, hiddenDeleted: 0 }, '老服务端没有 deletedCount');
});
