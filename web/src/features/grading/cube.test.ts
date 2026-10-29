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

test('胶片效果：读 params.film、是否开启、改一项与清空', async () => {
  const { jobFilm, filmEffectsOn, patchFilm } = await import('./cube.ts');
  assert.deepEqual(jobFilm({ params: {} }), {});
  assert.deepEqual(jobFilm({ params: { film: [1] } }), {});
  assert.equal(filmEffectsOn({ filmFormatMm: 60 }), false);
  assert.equal(filmEffectsOn({ grain: 0.5 }), true);
  assert.deepEqual(patchFilm({ grain: 1 }, 'halation', 0.2), { grain: 1, halation: 0.2 });
  assert.equal(patchFilm({ grain: 1 }, 'grain', null), null);
});

test('配方：新字段 recipe 优先，旧 look / strength / film 折算', async () => {
  const { jobRecipe, jobDefaults, jobFilm } = await import('./cube.ts');
  assert.deepEqual(jobRecipe({ params: { recipe: { lookId: 'a', kind: 'film', params: { strength: 0.4, grain: 1 } } } }), { lookId: 'a', kind: 'film', params: { strength: 0.4, grain: 1 } });
  assert.deepEqual(jobDefaults({ params: { recipe: { lookId: 'a', params: { strength: 0.4 } } } }), { look: 'a', strength: 0.4 });
  assert.deepEqual(jobRecipe({ params: { look: 'b', strength: 0.5, film: { grain: 2 } } }), { lookId: 'b', params: { strength: 0.5, grain: 2 } });
  assert.deepEqual(jobFilm({ params: { recipe: { lookId: 'a', params: { grain: 1, paper: 'edgepaper' } } } }), { grain: 1 });
});

test('参数模式：.cube 查询串只带影响 LUT 且改过的项；归一按类型；缺省值不存', async () => {
  const { cubeQuery, paramsForKind, patchParams } = await import('./cube.ts');
  const schema = { kind: 'film', label: 'f', groups: [{ id: 'look', label: 'l' }], params: [
    { key: 'strength', label: 's', group: 'look', type: 'number', min: 0, max: 1, step: 0.1, default: 1, preview: 'lut' },
    { key: 'paper', label: 'p', group: 'look', type: 'enum', options: [], default: 'premierpaper', preview: 'lut' },
    { key: 'grain', label: 'g', group: 'look', type: 'number', min: 0, max: 4, step: 0.25, default: 0, preview: 'export' },
  ] } as unknown as import('../../core/types.ts').LookKindSchema;
  assert.equal(cubeQuery(schema, { strength: 0.5, paper: 'edgepaper', grain: 1 }), 'paper=edgepaper');
  assert.equal(cubeQuery(schema, { paper: 'premierpaper' }), '');
  assert.deepEqual(paramsForKind(schema, { grain: 1, borderWidth: 0.1 }), { grain: 1 });
  assert.deepEqual(patchParams(schema, { grain: 1 }, 'grain', 0), {});
  assert.deepEqual(patchParams(schema, {}, 'paper', 'edgepaper'), { paper: 'edgepaper' });
});

test('边框画布：与服务端同一算法', async () => {
  const { borderLayout } = await import('./cube.ts');
  assert.deepEqual(borderLayout(300, 200, { width: 0.1, ratio: 'original' }), { width: 340, height: 240, x: 20, y: 20 });
  assert.deepEqual(borderLayout(300, 200, { width: 0, ratio: '1:1' }), { width: 300, height: 300, x: 0, y: 50 });
});
