import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobItem } from '../../core/types.ts';
import { exportSummary, isStageEditable, clampStrength, cycleLook, isOverridden, parseCube, recipeOf, reviewProgress } from './cube.ts';

test('cube：解析 2³ 并拒绝坏文件', () => {
  const rows = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) rows.push(`${r} ${g} ${b}`);
  const lut = parseCube(`TITLE "x"\n# c\nLUT_3D_SIZE 2\n${rows.join('\n')}\n`);
  assert.equal(lut.size, 2);
  assert.equal(lut.table[3], 1);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'));
});

test('配方：覆盖优先，null = 不套用；过目计数不算 skipped', () => {
  const job = { params: { look: 'mono400', strength: 0.8 }, items: [
    { id: 'a', status: 'planned', grade: { look: 'vivid100', reviewedAt: 't' } },
    { id: 'b', status: 'planned', grade: { look: null } },
    { id: 'c', status: 'planned' },
    { id: 'v', status: 'skipped' },
  ] as JobItem[] };
  assert.deepEqual(recipeOf(job, job.items[0]), { look: 'vivid100', strength: 0.8 });
  assert.deepEqual(recipeOf(job, job.items[1]), { look: null, strength: 0.8 });
  assert.deepEqual(recipeOf(job, job.items[2]), { look: 'mono400', strength: 0.8 });
  assert.equal(isOverridden(job.items[1]), true);
  assert.equal(isOverridden(job.items[2]), false);
  assert.deepEqual(reviewProgress(job), { reviewed: 1, total: 3 });
});

test('快捷键辅助：强度夹到 0–1、风格循环含原图', () => {
  assert.equal(clampStrength(1.2), 1);
  assert.equal(clampStrength(0.35), 0.4);
  assert.equal(cycleLook(['a', 'b'], 'b', 1), null);
  assert.equal(cycleLook(['a', 'b'], null, -1), 'b');
  assert.equal(cycleLook(['a', 'b'], 'a', 1), 'b');
});

test('收场后只读：done / failed / cancelled 不能再改', () => {
  assert.equal(isStageEditable({ state: 'running' }), true);
  assert.equal(isStageEditable({ state: 'interrupted' }), true);
  for (const state of ['done', 'failed', 'cancelled'] as const) assert.equal(isStageEditable({ state }), false);
  const items = [{ status: 'done' }, { status: 'failed' }, { status: 'skipped' }] as JobItem[];
  assert.deepEqual(exportSummary({ items }), { done: 1, failed: 1 });
});

test('导出中：配方锁定、逐张状态、RAW 内嵌标记', async () => {
  const { isExporting, isRawEmbedded, itemExportLabel } = await import('./cube.ts');
  const job = { state: 'running', phase: 'exporting' } as never;
  assert.equal(isStageEditable(job), false);
  assert.equal(isExporting(job), true);
  assert.equal(isExporting({ state: 'done', phase: null } as never), false);
  assert.equal(isStageEditable({ state: 'running', phase: null } as never), true);
  assert.equal(itemExportLabel(job, { status: 'planned' } as never), '导出中…');
  assert.equal(itemExportLabel(job, { status: 'done' } as never), '已导出');
  assert.equal(itemExportLabel(job, { status: 'failed' } as never), '失败');
  assert.equal(itemExportLabel({ state: 'running' } as never, { status: 'planned', grade: { reviewedAt: 'x' } } as never), '✓');
  assert.equal(isRawEmbedded({ source: 'embedded_jpeg' }), true);
  assert.equal(isRawEmbedded({}), false);
});
