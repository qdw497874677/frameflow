import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCube, formatCube, identityLut, sampleLut, LutParseError } from '../src/domain/grading/lut.ts';
import { lutEffect, runEffects } from '../src/domain/grading/effects.ts';
import { resolveRecipe, exportName, isValidStrength } from '../src/domain/grading/recipe.ts';

const looksDir = path.join(import.meta.dirname, '..', 'assets', 'looks');
const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('cube：序列化再解析不变', () => {
  const lut = identityLut(5);
  const back = parseCube(formatCube(lut, 't'));
  assert.equal(back.size, 5);
  back.table.forEach((v, i) => near(v, lut.table[i]));
});

test('cube：尺寸或行数不对直接报错', () => {
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), LutParseError);
  assert.throws(() => parseCube('0 0 0\n'), LutParseError);
});

test('三线性插值：单位 LUT 原样返回，格点之间线性', () => {
  const lut = identityLut(3);
  const out = sampleLut(lut, 0.3, 0.75, 1.2);
  near(out[0], 0.3); near(out[1], 0.75); near(out[2], 1);
  // 只有一个格点变了的 LUT：中点取到一半
  const t = Float32Array.from(identityLut(2).table);
  t[21] = 0; // (1,1,1) 的红
  const half = sampleLut({ size: 2, table: t }, 1, 1, 0.5);
  near(half[0], 0.5);
});

test('LUT 效果：强度 0 不变、1 完全套用、0.5 居中；alpha 不动', () => {
  const invert = identityLut(2);
  const t = invert.table.map((v) => 1 - v);
  const lut = { size: 2, table: t };
  const px = () => Uint8Array.from([200, 100, 0, 77]);
  const a = px(); lutEffect(lut, 0).apply(a, 4); assert.deepEqual([...a], [200, 100, 0, 77]);
  const b = px(); runEffects(b, 4, [lutEffect(lut, 1)]); assert.deepEqual([...b], [55, 155, 255, 77]);
  const c = px(); lutEffect(lut, 0.5).apply(c, 4); assert.deepEqual([...c], [128, 128, 128, 77]);
});

test('配方：逐张覆盖优先，null 表示不套用；文件名', () => {
  const d = { look: 'portrait400', strength: 1 };
  assert.deepEqual(resolveRecipe(d), d);
  assert.deepEqual(resolveRecipe(d, { strength: 0.4 }), { look: 'portrait400', strength: 0.4 });
  assert.deepEqual(resolveRecipe(d, { look: null }), { look: null, strength: 1 });
  assert.equal(exportName('IMG_0001.CR3', 'mono400'), 'IMG_0001_mono400.jpg');
  assert.equal(exportName('a/b.jpg', null), 'a_b.jpg');
  assert.equal(isValidStrength(1.2), false);
  assert.equal(isValidStrength(0), true);
});

test('内置风格：每个都能解析、33³，并附许可与署名', () => {
  const looks = JSON.parse(fs.readFileSync(path.join(looksDir, 'looks.json'), 'utf8'));
  assert.equal(looks.length, 7);
  for (const look of looks) {
    assert.match(look.id, /^[a-z0-9]+$/);
    const lut = parseCube(fs.readFileSync(path.join(looksDir, `${look.id}.cube`), 'utf8'));
    assert.equal(lut.size, 33);
  }
  const notice = fs.readFileSync(path.join(looksDir, 'NOTICE'), 'utf8');
  for (const s of ['CC BY-SA 4.0', 'Pat David', 'Pavlov Dmitry', 'Michael Ezra']) assert.ok(notice.includes(s), s);
  assert.match(fs.readFileSync(path.join(looksDir, 'LICENSE'), 'utf8'), /Attribution-ShareAlike 4\.0/);
});
