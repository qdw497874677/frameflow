import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WriterGuard } from '../src/connectors/writer.ts';

const cleanups = new Map();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-storage-'));
  const stack = [];
  cleanups.set(dir, stack);
  t.after(() => {
    try { for (const cleanup of stack.reverse()) cleanup(); }
    finally { cleanups.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  return dir;
}
function open(t, dir, options) {
  const guard = WriterGuard.acquire(dir);
  const journal = guard.openJournal('events.jsonl', options);
  cleanups.get(dir).push(() => { journal.close(); guard.release(); });
  return { guard, journal };
}

test('versioned checksummed records survive reopen; guard owns all writes', t => {
  const dir = fixture(t);
  const { guard, journal } = open(t, dir);
  assert.throws(() => WriterGuard.acquire(dir), /LOCK_OCCUPIED/);
  assert.throws(() => guard.openJournal('events.jsonl'), /JOURNAL_OPEN/);
  assert.throws(() => guard.openJournal('../escape'), /INVALID_NAME/);
  assert.throws(() => guard.release(), /JOURNALS_OPEN/);
  const result = journal.append('stable-id', { value: '你好' });
  assert.equal(result.version, 1);
  assert.equal(result.sequence, 1);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(dir, 'events.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, '.connector-writer.lock')).mode & 0o777, 0o600);
  journal.close();
  const reopened = guard.openJournal('events.jsonl');
  assert.deepEqual(reopened.records, [result]);
  reopened.close();
  guard.release();
  assert.throws(() => guard.openJournal('other.jsonl'), /LOCK_LOST/);
});

test('truncated tail requires explicit repair with diagnostic, then clean append', t => {
  const dir = fixture(t);
  const { guard, journal } = open(t, dir);
  journal.append('one', { text: '你好�' }); journal.close();
  const prefix = fs.readFileSync(path.join(dir, 'events.jsonl'));
  assert.ok(prefix.length > prefix.toString('utf8').length);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"partial":');
  assert.throws(() => guard.openJournal('events.jsonl'), /TRUNCATED_TAIL/);
  const repaired = guard.openJournal('events.jsonl', { repairTail: true });
  assert.equal(repaired.repair.offset, prefix.length);
  assert.equal(repaired.repair.removedBytes, 11);
  assert.equal(repaired.repair.code, 'TRUNCATED_TAIL_REPAIRED');
  repaired.append('two', { n: 2 }); repaired.close();
  const replay = guard.openJournal('events.jsonl');
  assert.equal(replay.records.length, 2); replay.close();
});

test('middle corruption fails closed without repairing or changing bytes', t => {
  const dir = fixture(t);
  const { guard, journal } = open(t, dir);
  journal.append('one', { n: 1 }); journal.append('two', { n: 2 }); journal.close();
  const file = path.join(dir, 'events.jsonl');
  const bad = fs.readFileSync(file, 'utf8').replace('"n":1', '"n":9') + 'partial';
  fs.writeFileSync(file, bad);
  assert.throws(() => guard.openJournal('events.jsonl', { repairTail: true }), /CORRUPT_RECORD/);
  assert.equal(fs.readFileSync(file, 'utf8'), bad);
});

for (const failure of ['append', 'flush']) {
  test(`${failure} failure poisons writer and subsequent attempts cannot concatenate garbage`, t => {
    const dir = fixture(t);
    let fail = true;
    const io = {
      write(fd, bytes) {
        if (failure === 'append' && fail) { fs.writeSync(fd, bytes.subarray(0, 9)); throw new Error('injected append'); }
        return fs.writeSync(fd, bytes);
      },
      sync(fd) { if (failure === 'flush' && fail) throw new Error('injected flush'); fs.fsyncSync(fd); },
    };
    const { guard, journal } = open(t, dir, { io });
    assert.throws(() => journal.append('one', { n: 1 }), /injected/);
    const before = fs.readFileSync(path.join(dir, 'events.jsonl'));
    assert.equal(journal.records.length, 0);
    fail = false;
    assert.throws(() => journal.append('two', {}), /JOURNAL_POISONED/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'events.jsonl')), before);
    journal.close();
    const recovered = guard.openJournal('events.jsonl', { repairTail: true });
    recovered.append('three', {});
    assert.equal(recovered.records.length, failure === 'append' ? 1 : 2);
    recovered.close();
  });
}

test('bounds and invalid input do not write; short writes are completed before fsync', t => {
  const dir = fixture(t); let synced = 0;
  const { journal } = open(t, dir, { io: {
    write: (fd, bytes) => fs.writeSync(fd, bytes.subarray(0, 7)),
    sync: fd => { synced++; fs.fsyncSync(fd); },
  } });
  assert.throws(() => journal.append('', {}), /INVALID_RECORD/);
  assert.throws(() => journal.append('large', 'x'.repeat(1024 * 1024)), /RECORD_TOO_LARGE/);
  assert.equal(fs.statSync(path.join(dir, 'events.jsonl')).size, 0);
  journal.append('ok', {});
  assert.equal(synced, 1);
});

test('release never deletes a replacement lock; symlinks are refused', t => {
  const dir = fixture(t); const guard = WriterGuard.acquire(dir);
  const lock = path.join(dir, '.connector-writer.lock');
  fs.renameSync(lock, lock + '.old');
  const replacement = WriterGuard.acquire(dir);
  assert.throws(() => guard.release(), /LOCK_LOST/);
  assert.ok(fs.existsSync(lock));
  replacement.release();
  const next = WriterGuard.acquire(dir);
  fs.writeFileSync(path.join(dir, 'target'), 'untouched');
  fs.symlinkSync('target', path.join(dir, 'events.jsonl'));
  assert.throws(() => next.openJournal('events.jsonl'));
  assert.equal(fs.readFileSync(path.join(dir, 'target'), 'utf8'), 'untouched');
  next.release();
});

const moduleURL = new URL('../src/connectors/writer.ts', import.meta.url).href;
function child(dir) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    import { WriterGuard } from ${JSON.stringify(moduleURL)};
    process.send('ready');
    process.once('message', () => {
      try {
        const g = WriterGuard.acquire(process.argv[1]);
        g.openJournal('events.jsonl').append('before-kill', { durable: true });
        process.send({ acquired: true, identity: g.identity });
      }
      catch (e) { process.send({ acquired: false, error: e.message }); }
      setInterval(() => {}, 1000);
    });
  `, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
}
test('two subprocesses compete atomically; killed owner lock refuses takeover', { timeout: 10000 }, async t => {
  const dir = fixture(t);
  const children = [child(dir), child(dir)];
  t.after(() => children.forEach(c => c.kill('SIGKILL')));
  await Promise.all(children.map(c => once(c, 'message')));
  const results = children.map(c => once(c, 'message'));
  children.forEach(c => c.send('go'));
  const messages = (await Promise.all(results)).map(([m]) => m);
  assert.equal(messages.filter(m => m.acquired).length, 1);
  const winnerIndex = messages.findIndex(m => m.acquired);
  assert.match(messages[winnerIndex].identity.bootId, /^[a-f0-9-]+$/);
  assert.match(messages[winnerIndex].identity.startTicks, /^\d+$/);
  assert.match(messages[1 - winnerIndex].error, /LOCK_OCCUPIED/);
  for (const c of children) { const exit = once(c, 'exit'); c.kill('SIGKILL'); await exit; }
  assert.throws(() => WriterGuard.acquire(dir), /LOCK_OCCUPIED/);
  // Explicit operator recovery only after all participating processes are known stopped.
  fs.renameSync(path.join(dir, '.connector-writer.lock'), path.join(dir, 'archived-lock'));
  const { journal } = open(t, dir);
  assert.deepEqual(journal.records.map(r => r.id), ['before-kill']);
});

test('unknown version, malformed complete tail, reordered records and oversized replay fail closed', t => {
  const dir = fixture(t); const { guard, journal } = open(t, dir);
  journal.append('one', {}); journal.append('two', {}); journal.close();
  const file = path.join(dir, 'events.jsonl'); const original = fs.readFileSync(file, 'utf8');
  for (const bad of [original.replace('"version":1', '"version":2'), original + 'bad\n', original.split('\n').slice(0, 2).reverse().join('\n') + '\n']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => guard.openJournal('events.jsonl', { repairTail: true }), /CORRUPT_RECORD/);
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
  }
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.throws(() => guard.openJournal('events.jsonl'), /JOURNAL_TOO_LARGE/);
});

test('malformed and PID-reused locks never auto-steal', t => {
  const dir = fixture(t); const lock = path.join(dir, '.connector-writer.lock');
  for (const value of ['', 'garbage', JSON.stringify({ pid: process.pid, bootId: 'old-boot', startTicks: '0', token: 'old' })]) {
    fs.writeFileSync(lock, value);
    assert.throws(() => WriterGuard.acquire(dir), /LOCK_OCCUPIED/);
    assert.equal(fs.readFileSync(lock, 'utf8'), value);
  }
});

test('zero-byte append failure is poisoned, and serialization cannot close then write a stale fd', t => {
  const dir = fixture(t);
  const { guard, journal } = open(t, dir, { io: { write: () => 0, sync: () => assert.fail('must not flush') } });
  assert.throws(() => journal.append('zero', {}), /INVALID_WRITE_RESULT/);
  assert.throws(() => journal.append('again', {}), /JOURNAL_POISONED/);
  journal.close();
  const second = guard.openJournal('events.jsonl');
  assert.throws(() => second.append('closed', { toJSON() { second.close(); return {}; } }), /JOURNAL_CLOSED/);
  assert.equal(fs.statSync(path.join(dir, 'events.jsonl')).size, 0);
});


test('invalid UTF-8 cannot impersonate a checksummed replacement character in a middle record', t => {
  const dir = fixture(t); const { guard, journal } = open(t, dir);
  journal.append('before', { text: '你好' });
  journal.append('middle', { text: 'valid � character' });
  journal.append('after', {}); journal.close();
  const file = path.join(dir, 'events.jsonl');
  const original = fs.readFileSync(file);
  const index = original.indexOf(Buffer.from('�'));
  assert.ok(index > 0);
  const bad = Buffer.concat([original.subarray(0, index), Buffer.from([0xff]), original.subarray(index + 3), Buffer.from('partial')]);
  fs.writeFileSync(file, bad);
  assert.throws(() => guard.openJournal('events.jsonl', { repairTail: true }), /CORRUPT_RECORD/);
  assert.deepEqual(fs.readFileSync(file), bad);
});

for (const failingCall of [1, 2, 3]) {
  test(`recovery sync failure at call ${failingCall} never returns a writable journal`, t => {
    const dir = fixture(t); const { guard, journal } = open(t, dir);
    journal.append('one', {}); journal.close();
    const file = path.join(dir, 'events.jsonl'); const prefix = fs.readFileSync(file);
    fs.appendFileSync(file, 'partial');
    let calls = 0; let recovered;
    assert.throws(() => {
      recovered = guard.openJournal('events.jsonl', { repairTail: true, recoverySync(fd) {
        if (++calls === failingCall) throw new Error('injected recovery sync');
        fs.fsyncSync(fd);
      } });
    }, /injected recovery sync/);
    assert.equal(recovered, undefined);
    assert.equal(calls, failingCall);
    assert.deepEqual(fs.readFileSync(file), failingCall === 3 ? prefix : Buffer.concat([prefix, Buffer.from('partial')]));
    // Failed open releases its reservation, but only a successful recovery may write.
    const retry = guard.openJournal('events.jsonl', { repairTail: true });
    assert.deepEqual(retry.records.map(r => r.id), ['one']);
    retry.append('two', {}); retry.close();
  });
}

for (const phase of ['partial-write', 'complete-before-fsync']) {
  test(`subprocess killed at ${phase} barrier recovers without an append acknowledgement`, { timeout: 10000 }, async t => {
    const dir = fixture(t);
    const c = spawn(process.execPath, ['--input-type=module', '-e', `
      import * as fs from 'node:fs';
      import { WriterGuard } from ${JSON.stringify(moduleURL)};
      const g = WriterGuard.acquire(process.argv[1]);
      const seed = g.openJournal('events.jsonl');
      seed.append('durable', { text: '你好' }); seed.close();
      const j = g.openJournal('events.jsonl', { io: {
        write(fd, bytes) {
          const count = fs.writeSync(fd, ${JSON.stringify(phase)} === 'partial-write' ? bytes.subarray(0, 13) : bytes);
          process.send({ barrier: ${JSON.stringify(phase)}, count, length: bytes.length, identity: g.identity });
          // Synchronous barrier: cannot return to append's fsync/ack before parent kills.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          throw new Error('barrier unexpectedly resumed');
        },
        sync(fd) { process.send('unexpected-fsync'); fs.fsyncSync(fd); }
      } });
      j.append('unknown', { text: '�' });
      process.send('unexpected-ack');
    `, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => c.kill('SIGKILL'));
    const messages = []; c.on('message', m => messages.push(m));
    const [barrier] = await once(c, 'message');
    assert.equal(barrier.barrier, phase);
    assert.equal(barrier.identity.pid, c.pid);
    assert.equal(barrier.count, phase === 'partial-write' ? 13 : barrier.length);
    assert.throws(() => WriterGuard.acquire(dir), /LOCK_OCCUPIED/);
    const exit = once(c, 'exit'); c.kill('SIGKILL');
    assert.deepEqual(await exit, [null, 'SIGKILL']);
    assert.deepEqual(messages, [barrier]);
    assert.throws(() => WriterGuard.acquire(dir), /LOCK_OCCUPIED/);
    // No process remains alive: explicit manual recovery, never live lock stealing.
    fs.renameSync(path.join(dir, '.connector-writer.lock'), path.join(dir, 'archived-lock'));
    const guard = WriterGuard.acquire(dir);
    cleanups.get(dir).push(() => guard.release());
    const file = path.join(dir, 'events.jsonl'); const crashed = fs.readFileSync(file);
    if (phase === 'partial-write') {
      assert.throws(() => guard.openJournal('events.jsonl'), /TRUNCATED_TAIL/);
      assert.deepEqual(fs.readFileSync(file), crashed);
    }
    const recovered = guard.openJournal('events.jsonl', { repairTail: true });
    cleanups.get(dir).push(() => recovered.close());
    assert.deepEqual(recovered.records.map(r => r.id), phase === 'partial-write' ? ['durable'] : ['durable', 'unknown']);
    if (phase === 'partial-write') {
      assert.equal(recovered.repair.removedBytes, 13);
      assert.equal(recovered.repair.offset, crashed.length - 13);
    } else {
      assert.equal(recovered.repair, undefined);
      assert.deepEqual(fs.readFileSync(file), crashed);
    }
    recovered.append('after-recovery', {}); recovered.close();
    const replay = guard.openJournal('events.jsonl');
    assert.equal(replay.records.at(-1).id, 'after-recovery'); replay.close();
  });
}

function encodedRecord(sequence, payload = null) {
  const body = { version: 1, sequence, id: `record-${sequence}`, payload };
  const checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return JSON.stringify({ ...body, checksum }) + '\n';
}

test('oversized complete record fails closed even with tail repair enabled', t => {
  const dir = fixture(t); const { guard, journal } = open(t, dir); journal.close();
  const file = path.join(dir, 'events.jsonl');
  const bad = Buffer.from(encodedRecord(1, 'x'.repeat(1024 * 1024)) + 'partial');
  fs.writeFileSync(file, bad);
  assert.throws(() => guard.openJournal('events.jsonl', { repairTail: true }), /CORRUPT_RECORD: bounds/);
  assert.deepEqual(fs.readFileSync(file), bad);
});

test('record-count cap allows exactly 100000 records but refuses append and over-cap replay', { timeout: 15000 }, t => {
  const dir = fixture(t); const { guard, journal } = open(t, dir); journal.close();
  const file = path.join(dir, 'events.jsonl');
  // Generate valid checksummed fixtures in bulk, avoiding 100000 unrelated fsyncs.
  const atCap = Buffer.from(Array.from({ length: 100000 }, (_, i) => encodedRecord(i + 1)).join(''));
  fs.writeFileSync(file, atCap);
  const full = guard.openJournal('events.jsonl');
  assert.equal(full.records.length, 100000);
  assert.throws(() => full.append('over-cap', {}), /JOURNAL_TOO_LARGE/);
  full.close();
  assert.deepEqual(fs.readFileSync(file), atCap);
  const bad = Buffer.concat([atCap, Buffer.from(encodedRecord(100001) + 'partial')]);
  fs.writeFileSync(file, bad);
  assert.throws(() => guard.openJournal('events.jsonl', { repairTail: true }), /CORRUPT_RECORD: bounds/);
  assert.deepEqual(fs.readFileSync(file), bad);
});
