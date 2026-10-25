#!/usr/bin/env node
/** Standalone filesystem regression: node server/tools/e2e-marks-durability.mjs */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarksStore } from '../src/core/marks.ts';
import { readXmpMarks } from '../src/core/xmp.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'artworks-marks-durability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const sidecar = join(root, 'photo.xmp');
  writeFileSync(sidecar, '<rdf:Description xmp:Rating="1" crs:Exposure2012="0.50"/>');
  const store = new MarksStore(data);
  store.seedFromXmp('photo', { stars: 1 });
  const lookup = (id) => id === 'photo' ? { displayName: 'photo', sidecarPath: sidecar } : null;
  return { root, data, sidecar, store, lookup, log: join(data, 'marks.jsonl') };
}

const transitions = (changes) => changes.map(({ field, from, to }) => [field, from, to]);

test('append failure publishes nothing, skips sidecars, and an identical retry persists', async (t) => {
  const { root, data, sidecar, store, lookup, log } = fixture(t);
  await store.apply([{ id: 'photo', stars: 2, by: 'original' }], lookup);
  const before = { ...store.get('photo') };
  const history = store.list({ limit: 0 });
  const xml = readFileSync(sidecar, 'utf8');
  const savedLog = readFileSync(log, 'utf8');
  renameSync(log, `${log}.saved`);
  // A directory at the append destination fails deterministically, even as root.
  mkdirSync(log);
  const items = [
    { id: 'photo', stars: 2, by: 'noop' },
    { id: 'missing', stars: 5 },
    { id: 'photo', stars: 4, by: 'retry' },
    { id: 'photo', del: true, by: 'retry' },
  ];
  const failed = await store.apply(items, lookup);
  assert.deepEqual(failed.map((r) => r.ok), [false, false, false, false]);
  for (const i of [0, 2, 3]) assert.match(failed[i].error, /变更日志写不进去/);
  assert.match(failed[1].error, /不认识/);
  assert.deepEqual(store.get('photo'), before);
  assert.equal(store.lastBy('photo'), 'original');
  assert.deepEqual(store.list({ limit: 0 }), history);
  assert.equal(readFileSync(sidecar, 'utf8'), xml);
  assert.deepEqual(readdirSync(root).sort(), ['data', 'photo.xmp']);

  rmSync(log, { recursive: true });
  renameSync(`${log}.saved`, log);
  const retried = await store.apply(items, lookup);
  assert.deepEqual(retried.map((r) => r.ok), [true, false, true, true]);
  assert.equal(retried[1].error, failed[1].error);
  assert.equal(store.starsOf('photo'), 0);
  assert.equal(store.delOf('photo'), true);
  assert.equal(store.lastBy('photo'), 'retry');
  assert.deepEqual(transitions(store.list().slice(0, 3)), [
    ['del', false, true], ['stars', 4, 0], ['stars', 2, 4],
  ]);
  assert.ok(readFileSync(log, 'utf8').startsWith(savedLog));
  const reloaded = new MarksStore(data);
  assert.deepEqual(reloaded.get('photo'), store.get('photo'));
  assert.deepEqual(reloaded.list(), store.list());
  assert.deepEqual(await readXmpMarks(sidecar), { stars: 0, del: true });
  assert.match(readFileSync(sidecar, 'utf8'), /crs:Exposure2012="0.50"/);
});

test('duplicate IDs use staged values and unchanged repeats do not add history', async (t) => {
  const { data, sidecar, store, lookup, log } = fixture(t);
  const results = await store.apply([
    { id: 'photo', stars: 4 },
    { id: 'photo', stars: 4 },
    { id: 'missing', del: true },
    { id: 'photo', del: true },
    { id: 'photo', del: false, stars: 3 },
  ], lookup);
  assert.deepEqual(results.map(({ ok, stars, del }) => [ok, stars, del]), [
    [true, 4, false], [true, 4, false], [false, undefined, undefined],
    [true, 0, true], [true, 3, false],
  ]);
  assert.deepEqual(transitions(store.list()).reverse(), [
    ['stars', 1, 4], ['stars', 4, 0], ['del', false, true],
    ['stars', 0, 3], ['del', true, false],
  ]);
  const persisted = readFileSync(log, 'utf8');
  await store.apply([{ id: 'photo', stars: 3 }], lookup);
  // F03: same-value writes commit a new full-state revision, but no fake changes.
  const after = readFileSync(log, 'utf8');
  assert.ok(after.startsWith(persisted));
  const confirmation = JSON.parse(after.slice(persisted.length));
  assert.equal(confirmation.version, 1);
  assert.equal(confirmation.entries[0].newRevision, 5);
  assert.deepEqual(confirmation.entries[0].changes, []);
  assert.deepEqual(new MarksStore(data).list(), store.list());
  assert.equal(new MarksStore(data).starsOf('photo'), 3);
  assert.deepEqual(await readXmpMarks(sidecar), { stars: 3 });
});

test('XMP-only failure retains ok:true and durable state, with invalid IDs isolated', async (t) => {
  const { root, data, store } = fixture(t);
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'block sidecar writes');
  const results = await store.apply([
    { id: 'photo', stars: 5, by: 'fallback' }, { id: 'missing', stars: 3 },
  ], (id) => id === 'photo' ? { displayName: 'photo', sidecarPath: join(blocked, 'photo.xmp') } : null);
  assert.equal(results[0].ok, true);
  assert.match(results[0].error, /XMP.*状态已记在服务端日志里/);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /不认识/);
  assert.equal(store.starsOf('photo'), 5);
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.list().length, 1);
  const reloaded = new MarksStore(data);
  assert.deepEqual(reloaded.get('photo'), store.get('photo'));
  assert.deepEqual(reloaded.list(), store.list());
});
