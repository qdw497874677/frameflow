import test from 'node:test';
import assert from 'node:assert/strict';
import { identityLut } from '../src/domain/grading/lut.ts';
import { runEffects } from '../src/domain/grading/effects.ts';
import { paramProblems, normalizeParams } from '../src/domain/grading/look-kind.ts';
import { borderLayout, borderEffect, vignetteEffect } from '../src/domain/grading/frame-extras.ts';
import { filmRenderParams, FILM_PRESETS } from '../src/domain/grading/film-presets.ts';
import { recipeFromParams, legacyRecipe, hasLegacyFields } from '../src/domain/grading/recipe.ts';
import { LookKindRegistry, LutKind } from '../src/application/grading/look-kinds.ts';

const cubes = { list: () => [{ id: 'chrome64', name: 'Chrome 64' }], load: async (id) => (id === 'chrome64' ? identityLut(5) : null) };
const lut = new LutKind(cubes);

test('风格类型：LUT 类型的模式带强度、暗角、边框，且自带分组', () => {
  const s = lut.schema();
  assert.equal(s.kind, 'lut');
  for (const k of ['strength', 'vignette', 'borderWidth', 'borderColor', 'borderRatio']) assert.ok(s.params.some((p) => p.key === k), k);
  for (const p of s.params) assert.ok(s.groups.some((g) => g.id === p.group), `${p.key} 的分组存在`);
  assert.ok(s.groups.find((g) => g.id === 'border').extra);
});

test('风格类型：参数校验拒未知键与越界，归一丢掉坏值、颜色转小写', () => {
  const s = lut.schema();
  assert.deepEqual(paramProblems(s, { strength: 0.5, borderColor: '#FFAA00', borderRatio: '4:5' }), []);
  assert.equal(paramProblems(s, { strength: 2 }).length, 1);
  assert.equal(paramProblems(s, { nope: 1 }).length, 1);
  assert.equal(paramProblems(s, { borderRatio: '7:3' }).length, 1);
  assert.equal(paramProblems(s, { borderColor: 'red' }).length, 1);
  assert.equal(paramProblems(s, 'x').length, 1);
  assert.deepEqual(normalizeParams(s, { strength: 0.4, grain: 1, borderColor: '#FFAA00', vignette: 9 }), { strength: 0.4, borderColor: '#ffaa00' });
});

test('配方：新字段优先，旧 look/strength/film 折算进 params', () => {
  assert.deepEqual(recipeFromParams({ recipe: { lookId: 'a', kind: 'lut', params: { strength: 0.3 } }, look: 'b' }), { lookId: 'a', kind: 'lut', params: { strength: 0.3 } });
  const r = legacyRecipe({ look: 'b', strength: 0.5, film: { grain: 1 } });
  assert.equal(r.lookId, 'b');
  assert.equal(r.params.strength, 0.5);
  assert.equal(r.params.grain, 1);
  assert.ok(hasLegacyFields({ film: null }));
  assert.ok(!hasLegacyFields({ keepGps: true }));
});

test('注册表：按风格 id 找类型，列表带 kind', () => {
  const reg = new LookKindRegistry([{ kind: lut, source: cubes }]);
  assert.equal(reg.kindOf('chrome64')?.kind, 'lut');
  assert.equal(reg.kindOf('nope'), null);
  assert.deepEqual(reg.entries().map((e) => e.kind), ['lut']);
  assert.deepEqual(reg.kinds().map((k) => k.kind), ['lut']);
});

test('边框：等宽加边再补到目标画幅；效果改变图像尺寸并填色', async () => {
  assert.deepEqual(borderLayout(300, 200, { width: 0.1, color: '#ffffff', ratio: 'original' }), { width: 340, height: 240, x: 20, y: 20 });
  const L = borderLayout(300, 200, { width: 0, color: '#ffffff', ratio: '1:1' });
  assert.deepEqual([L.width, L.height], [300, 300]);
  const P = borderLayout(200, 300, { width: 0, color: '#ffffff', ratio: '4:5' });
  assert.ok(Math.abs(P.width / P.height - 0.8) < 0.01, '竖图按竖向 4:5');
  const w = 4, h = 2, px = new Uint8Array(w * h * 3).fill(10);
  const out = await runEffects(px, 3, [borderEffect({ width: 0.5, color: '#ff0000', ratio: 'original' })], { width: w, height: h });
  assert.deepEqual([out.width, out.height], [6, 4]);
  assert.deepEqual([...out.pixels.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...out.pixels.subarray(((1 * 6) + 1) * 3, ((1 * 6) + 1) * 3 + 3)], [10, 10, 10]);
  const effects = await lut.effects('chrome64', { borderWidth: 0.1 }, { seed: 1 });
  assert.deepEqual(effects.map((e) => e.id).slice(-1), ['border']);
});

test('暗角：中心不变、角落变暗', async () => {
  const w = 9, h = 9, px = new Uint8Array(w * h * 3).fill(200);
  await runEffects(px, 3, [vignetteEffect(1)], { width: w, height: h });
  assert.equal(px[(4 * w + 4) * 3], 200);
  assert.ok(px[0] < 120);
});

test('胶片预设：neutral 只带曝光，signature 按卷不同', () => {
  assert.deepEqual(FILM_PRESETS, ['signature', 'neutral', 'soft']);
  const n = filmRenderParams('portrait400', 'neutral', 0.5);
  assert.equal(n.exposureEv, 0.5);
  assert.notDeepEqual(filmRenderParams('vivid100', 'signature'), filmRenderParams('portrait160', 'signature'));
});
