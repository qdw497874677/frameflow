import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarksStore } from '../src/core/marks.ts';
import { hash } from '../src/core/mark-transaction.ts';

function fixture(t, options) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'marks-transactions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, log: join(dir, 'marks.jsonl'), store: new MarksStore(dir, options) };
}
const lookup = id => id === 'p' ? { displayName: 'photo' } : null;
const request = (opId, stars, revision) => ({ opId, items: [{ id: 'p', stars }], expectedRevisions: { p: revision } });

test('complete same-value commits advance revisions without fabricated history; stable op replays before conflict', async t => {
  const { dir, log, store } = fixture(t);
  store.seedFromXmp('p', { stars: 3 });
  const first = request('first', 3, 0);
  first.confirmation = { jobId: 'job', photoId: 'p' };
  const result = await store.transact(first, lookup);
  assert.equal(store.revisionOf('p'), 1);
  assert.equal(store.list().length, 0);
  const row = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(row.version, 1);
  assert.equal(row.entries[0].state.stars, 3);
  assert.equal(row.entries[0].state.del, false);
  assert.equal(row.entries[0].state.by, 'me');
  assert.equal(row.entries[0].state.channel, 'inapp');
  assert.ok(row.entries[0].state.at);
  await store.transact(request('newer', 5, 1), lookup);
  const bytes = fs.readFileSync(log, 'utf8');
  for (const s of [store, new MarksStore(dir)]) {
    assert.deepEqual(await s.transact(first, () => { throw Error('replay must not lookup/write XMP'); }), result);
    assert.equal(s.starsOf('p'), 5);
    assert.equal(s.revisionOf('p'), 2);
    await assert.rejects(s.transact({ ...first, items: [{ id: 'p', stars: 2 }] }, lookup), /OP_ID_REUSED/);
    await assert.rejects(s.transact(request('stale', 1, 0), lookup), /REVISION_CONFLICT/);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), bytes);
});

test('legacy rows establish deterministic per-photo revisions, mixed full states and flat history replay', async t => {
  const { dir, log } = fixture(t);
  const legacy = { photoId: 'p', field: 'stars', from: 0, to: 2, by: 'old', channel: 'inapp', at: 'old-time' };
  fs.writeFileSync(log, JSON.stringify(legacy) + '\n');
  const store = new MarksStore(dir);
  assert.equal(store.revisionOf('p'), 1);
  const out = await store.transact({ opId: 'batch', expectedRevisions: { p: 1 }, items: [
    { id: 'p', stars: 4 }, { id: 'missing', stars: 2 }, { id: 'p', stars: 4 }, { id: 'p', del: true },
  ] }, lookup);
  assert.deepEqual(out.results.map(x => x.ok), [true, false, true, true]);
  assert.equal(store.revisionOf('p'), 4);
  const again = new MarksStore(dir);
  assert.deepEqual(again.get('p'), store.get('p'));
  assert.deepEqual(again.list(), store.list());
  assert.ok(again.list().every(c => c.field && !('version' in c)));
  assert.equal(again.revisionOf('p'), 4);
});

test('complete corrupt/unknown rows fail closed; only explicit unterminated tail repair allowed', async t => {
  const { dir, log, store } = fixture(t);
  await store.transact(request('ok', 2, 0), lookup);
  const good = fs.readFileSync(log);
  for (const bad of ['{bad}\n', '{"version":99}\n', '{"photoId":"p","field":"wat"}\n', '\n']) {
    fs.writeFileSync(log, Buffer.concat([good, Buffer.from(bad)]));
    assert.throws(() => new MarksStore(dir, { repairTail: true }), /MARKS_CORRUPT/);
  }
  fs.writeFileSync(log, Buffer.concat([good, Buffer.from('{"version":1')]));
  assert.throws(() => new MarksStore(dir), /MARKS_TRUNCATED_TAIL/);
  const repaired = new MarksStore(dir, { repairTail: true });
  assert.ok(repaired.repair.removedBytes > 0);
  assert.equal(repaired.starsOf('p'), 2);
  assert.deepEqual(fs.readFileSync(log), good);
  await repaired.transact(request('after', 3, 1), lookup);
  assert.equal(new MarksStore(dir).starsOf('p'), 3);
});

test('partial append and flush failures do not publish; unknown poisons until recovery fsync', async t => {
  for (const fault of ['partial', 'flush']) {
    let calls = 0;
    let armed = false;
    const io = {
      write(fd, bytes) {
        if (armed && fault === 'partial') {
          if (++calls === 1) return fs.writeSync(fd, bytes.subarray(0, 12));
          throw Error('injected append');
        }
        return fs.writeSync(fd, bytes);
      },
      sync(fd) { if (armed && fault === 'flush') throw Error('injected flush'); fs.fsyncSync(fd); },
    };
    const { dir, store } = fixture(t, { io });
    await store.transact(request('base', 1, 0), lookup);
    const before = store.list();
    armed = true;
    await assert.rejects(store.transact(request('uncertain', 4, 1), lookup), /MARKS_COMMIT_UNKNOWN/);
    assert.equal(store.starsOf('p'), 1);
    assert.equal(store.revisionOf('p'), 1);
    assert.deepEqual(store.list(), before);
    await assert.rejects(store.transact(request('other', 5, 1), lookup), /MARKS_POISONED/);
    assert.throws(() => new MarksStore(dir, { repairTail: true, io: { ...io, sync() { throw Error('recovery fsync'); } } }), /recovery fsync/);
    const recovered = new MarksStore(dir, { repairTail: true });
    assert.equal(recovered.starsOf('p'), fault === 'flush' ? 4 : 1);
    const result = await recovered.transact(request('uncertain', 4, 1), lookup);
    assert.equal(result.results[0].ok, true);
    assert.equal(recovered.revisionOf('p'), 2);
  }
});

test('full-write loop, input validation and canonical request hashing', async t => {
  let writes = 0;
  const { store, dir } = fixture(t, { io: {
    write(fd, bytes) { writes++; return fs.writeSync(fd, bytes.subarray(0, 17)); }, sync: fs.fsyncSync,
  } });
  const first = request('canonical', 2, 0);
  const result = await store.transact(first, lookup);
  assert.ok(writes > 1);
  assert.deepEqual(await store.transact({ expectedRevisions: { p: 0 }, items: [{ stars: 2, id: 'p' }], opId: 'canonical' }, lookup), result);
  for (const bad of [{ ...first, opId: '' }, { ...first, expectedRevisions: { p: -1 } }, { ...first, confirmation: { bad: undefined } }]) {
    await assert.rejects(store.transact(bad, lookup), /INVALID_MARK_TRANSACTION/);
  }
  const result2 = await store.apply([{ id: 'p', stars: NaN }, { id: 'p', stars: 3 }], lookup);
  assert.deepEqual(result2.map(r => r.ok), [false, true]);
  assert.equal(new MarksStore(dir).starsOf('p'), 3);
});

test('tampered complete envelopes fail closed and replay does not roll back a real sidecar', async t => {
  const { dir, log, store } = fixture(t);
  const sidecar = join(dir, 'photo.xmp');
  const target = () => ({ sidecarPath: sidecar });
  const first = request('old', 1, 0);
  const result = await store.transact(first, target);
  await store.transact(request('latest', 5, 1), target);
  const xml = fs.readFileSync(sidecar, 'utf8');
  assert.deepEqual(await new MarksStore(dir).transact(first, target), result);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), xml);
  const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n');
  const row = JSON.parse(lines[0]);
  row.entries[0].state.stars = 4;
  fs.writeFileSync(log, JSON.stringify(row) + '\n' + lines[1] + '\n');
  assert.throws(() => new MarksStore(dir), /MARKS_CORRUPT/);
});

test('throwing write may already have appended a complete row; directory flush failure is unknown too', async t => {
  for (const fault of ['write-after', 'directory']) {
    const { dir, log } = fixture(t);
    let syncs = 0;
    const store = new MarksStore(dir, { io: {
      write(fd, bytes) { const n = fs.writeSync(fd, bytes); if (fault === 'write-after') throw Error('after append'); return n; },
      sync(fd) { if (fault === 'directory' && ++syncs === 2) throw Error('directory fsync'); fs.fsyncSync(fd); },
    } });
    const req = request('unknown', 3, 0);
    await assert.rejects(store.transact(req, lookup), /MARKS_COMMIT_UNKNOWN/);
    assert.equal(store.get('p'), undefined);
    await assert.rejects(store.transact(req, lookup), /MARKS_POISONED/);
    const bytes = fs.readFileSync(log, 'utf8');
    const reopened = new MarksStore(dir);
    assert.equal((await reopened.transact(req, lookup)).results[0].ok, true);
    assert.equal(fs.readFileSync(log, 'utf8'), bytes);
  }
});

for (const location of ['items', 'nested confirmation']) {
  test(`sparse arrays in ${location} are rejected without changing durable or memory state`, async t => {
    const { dir, log, store } = fixture(t);
    await store.transact(request('base', 2, 0), lookup);
    const bytes = fs.readFileSync(log);
    const state = store.get('p');
    const history = store.list();
    const bad = request('sparse', 4, 1);
    if (location === 'items') bad.items = [bad.items[0], , ];
    else bad.confirmation = { nested: [{ values: new Array(1) }] };
    await assert.rejects(store.transact(bad, lookup), /INVALID_MARK_TRANSACTION/);
    assert.deepEqual(fs.readFileSync(log), bytes);
    assert.deepEqual(store.get('p'), state);
    assert.deepEqual(store.list(), history);
    assert.equal(store.revisionOf('p'), 1);
    assert.deepEqual(new MarksStore(dir).get('p'), state);
    assert.equal((await store.transact(request('sparse', 4, 1), lookup)).revisions.p, 2);
  });
}

for (const corruption of ['duplicate operation', 'revision chain']) {
  test(`tail repair preserves every byte on complete ${corruption} corruption`, async t => {
    const { dir, log, store } = fixture(t);
    await store.transact(request('first', 2, 0), lookup);
    await store.transact(request('second', 3, 1), lookup);
    const rows = fs.readFileSync(log, 'utf8').trimEnd().split('\n').map(JSON.parse);
    if (corruption === 'duplicate operation') rows[1] = rows[0];
    else {
      rows[1].entries[0].expectedRevision = 8;
      rows[1].entries[0].newRevision = 9;
      rows[1].result.revisions.p = 9;
      const { checksum, ...body } = rows[1];
      rows[1].checksum = hash(body);
    }
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join('') + '{"partial":');
    fs.writeFileSync(log, bytes);
    assert.throws(() => new MarksStore(dir, { repairTail: true }), new RegExp(`MARKS_CORRUPT: ${corruption}`));
    assert.deepEqual(fs.readFileSync(log), bytes);
  });
}

test('malformed multibyte UTF-8 in a middle complete row cannot bypass checksum or trigger repair', async t => {
  const { dir, log, store } = fixture(t);
  await store.transact(request('first', 1, 0), lookup);
  await store.transact({ ...request('middle', 2, 1), confirmation: { text: '\uFFFD' } }, lookup);
  await store.transact(request('last', 3, 2), lookup);
  const good = fs.readFileSync(log);
  const at = good.indexOf(Buffer.from('\uFFFD'));
  assert.ok(at > 0);
  // An incomplete three-byte sequence decodes lossily to the same U+FFFD as the checksummed text.
  const bytes = Buffer.concat([good.subarray(0, at), Buffer.from([0xe2, 0x82]), good.subarray(at + 3), Buffer.from('{"partial":')]);
  fs.writeFileSync(log, bytes);
  assert.throws(() => new MarksStore(dir, { repairTail: true }), /MARKS_CORRUPT/);
  assert.deepEqual(fs.readFileSync(log), bytes);
});

test('get, list, transact and replay return defensive copies before and after reopen', async t => {
  const { dir, log, store } = fixture(t);
  const req = request('copies', 3, 0);
  const result = await store.transact(req, lookup);
  const expected = structuredClone(result);
  const state = store.get('p');
  const history = store.list();
  const bytes = fs.readFileSync(log);
  result.results[0].stars = 5;
  result.results.push({ id: 'injected', ok: false });
  result.revisions.p = 99;
  result.opId = 'mutated';
  for (const current of [store, new MarksStore(dir)]) {
    current.get('p').stars = 5;
    const list = current.list();
    list[0].to = 5;
    list.length = 0;
    const replay = await current.transact(req, () => { throw Error('no replay lookup'); });
    assert.deepEqual(replay, expected);
    replay.results[0].stars = 1;
    replay.revisions.p = 77;
    assert.deepEqual(await current.transact(req, lookup), expected);
    assert.deepEqual(current.get('p'), state);
    assert.deepEqual(current.list(), history);
    assert.equal(current.revisionOf('p'), 1);
  }
  assert.deepEqual(fs.readFileSync(log), bytes);
});
