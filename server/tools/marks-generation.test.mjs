import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarksStore } from '../src/core/marks.ts';
import { sourceGeneration, verifySourceGeneration } from '../src/core/source-generation.ts';

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'marks-generation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const rec = (path) => { const s = fs.statSync(path); return { jpeg: { path, size: s.size, mtimeMs: s.mtimeMs, ext: '.jpg' } }; };

test('同源重启版本稳定；同路径换源产生新generation；不可达返回null', async t => {
  const dir = fixture(t);
  const photo = join(dir, 'a.jpg');
  fs.writeFileSync(photo, 'one');
  const g1 = sourceGeneration(rec(photo));
  assert.match(g1, /^g1-[a-f0-9]{32}$/);
  assert.equal(sourceGeneration(rec(photo)), g1);
  assert.equal(await verifySourceGeneration(rec(photo)), g1);
  fs.rmSync(photo);
  fs.writeFileSync(photo, 'second source');
  fs.utimesSync(photo, new Date(), new Date(Date.now() + 5000));
  assert.notEqual(sourceGeneration(rec(photo)), g1);
  const stale = { jpeg: { path: join(dir, 'gone.jpg'), size: 1, mtimeMs: 1, ext: '.jpg' } };
  assert.equal(await verifySourceGeneration(stale), null);
  assert.equal(sourceGeneration({}), null);
});

test('换源后旧状态只留审计；同源重启保持已提交状态', async t => {
  const dir = fixture(t);
  const s = new MarksStore(dir);
  const look = gen => id => id === 'p' ? { displayName: 'p', generation: gen } : null;
  assert.equal(s.bindGeneration('p', 'gA'), 'adopted');
  await s.transact({ opId: 'o1', items: [{ id: 'p', stars: 4 }] }, look('gA'));
  const restarted = new MarksStore(dir);
  assert.equal(restarted.generationOf('p'), 'gA');
  assert.equal(restarted.bindGeneration('p', 'gA'), 'same');
  assert.equal(restarted.starsOf('p'), 4);
  // 同路径换源
  assert.equal(restarted.bindGeneration('p', 'gB'), 'replaced');
  assert.equal(restarted.starsOf('p'), 0);
  restarted.seedFromXmp('p', { stars: 1 });
  assert.equal(restarted.starsOf('p'), 1, '新源从自己的XMP建立基线');
  assert.equal(restarted.list({ photoId: 'p' }).length, 1, '旧历史保留审计');
  assert.equal(restarted.revisionOf('p'), 1, 'revision链不重置');
  await restarted.transact({ opId: 'o2', items: [{ id: 'p', del: true }] }, look('gB'));
  const again = new MarksStore(dir);
  assert.equal(again.generationOf('p'), 'gB');
  assert.equal(again.delOf('p'), true);
});

test('未重扫时写入发现新源：不继承旧状态', async t => {
  const dir = fixture(t);
  const s = new MarksStore(dir);
  s.bindGeneration('p', 'gA');
  await s.transact({ opId: 'o1', items: [{ id: 'p', stars: 5 }] }, () => ({ generation: 'gA' }));
  const [r] = (await s.transact({ opId: 'o2', items: [{ id: 'p', del: false }] }, () => ({ generation: 'gB' }))).results;
  assert.equal(r.stars, 0);
  assert.equal(s.generationOf('p'), 'gB');
  await assert.rejects(s.transact({ opId: 'o3', items: [{ id: 'p', stars: 1 }], expectedGenerations: { p: 'gA' } }, () => ({ generation: 'gB' })), /SOURCE_GENERATION_CONFLICT/);
});

test('不可达源不确认、不写XMP；失联恢复后可写', async t => {
  const dir = fixture(t);
  const s = new MarksStore(dir);
  const sidecar = join(dir, 'p.xmp');
  const [r] = await s.apply([{ id: 'p', stars: 3 }], () => ({ sidecarPath: null, generation: null }));
  assert.equal(r.ok, false);
  assert.match(r.error, /SOURCE_UNAVAILABLE/);
  assert.equal(s.revisionOf('p'), 0);
  assert.ok(!fs.existsSync(sidecar));
  const [ok] = await s.apply([{ id: 'p', stars: 3 }], () => ({ sidecarPath: sidecar, generation: 'gA' }));
  assert.equal(ok.ok, true);
  assert.equal(s.starsOf('p'), 3);
});

test('提交后XMP前崩溃：同源已提交事务优先于旧XMP；旧无generation数据按首个版本建立基线', async t => {
  const dir = fixture(t);
  const legacy = { photoId: 'p', field: 'stars', from: 0, to: 2, by: 'old', channel: 'inapp', at: 'old' };
  fs.writeFileSync(join(dir, 'marks.jsonl'), JSON.stringify(legacy) + '\n');
  const s = new MarksStore(dir);
  assert.equal(s.generationOf('p'), undefined);
  assert.equal(s.bindGeneration('p', 'gA'), 'adopted');
  assert.equal(s.starsOf('p'), 2, '旧数据成为该版本基线');
  // 模拟：事务已落盘但XMP未写（sidecar 不提供），重启后旧XMP=1 不覆盖
  await s.transact({ opId: 'o1', items: [{ id: 'p', stars: 5 }] }, () => ({ generation: 'gA' }));
  const restarted = new MarksStore(dir);
  restarted.bindGeneration('p', 'gA');
  restarted.seedFromXmp('p', { stars: 1 });
  assert.equal(restarted.starsOf('p'), 5);
});

test('含generation的日志行被校验；非法generation拒绝加载', async t => {
  const dir = fixture(t);
  const s = new MarksStore(dir);
  await s.transact({ opId: 'o1', items: [{ id: 'p', stars: 1 }] }, () => ({ generation: 'gA' }));
  const file = join(dir, 'marks.jsonl');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(row.entries[0].generation, 'gA');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"gA"', '"gZ"'));
  assert.throws(() => new MarksStore(dir), /MARKS_CORRUPT/);
});
