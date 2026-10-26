// 实时入库：领域规则、编排（假时钟 + 假端口，含「写到一半」）、目录监听端到端（真实服务 + SSE）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandInboxDir, isIngestible, isPartialName, PairingWindow, StabilityPolicy } from '../src/domain/ingest/arrival.ts';
import { IngestService } from '../src/application/ingest/service.ts';
import { LibraryEventLog } from '../src/application/library/events.ts';
import { inboxBase } from '../src/adapters/ingest/index.ts';
import { loadConfig } from '../src/adapters/outbound/config-file.ts';
import { Library } from '../src/adapters/outbound/fs/library.ts';
import { buildServer } from '../src/adapters/inbound/http/server.ts';

const require = createRequire(path.join(import.meta.dirname, '../package.json'));
const sharp = require('sharp');
const jpeg = (r = 10) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r, g: 80, b: 120 } } }).jpeg().toBuffer();
const flush = () => new Promise((r) => setImmediate(r));

// ── 领域 ──────────────────────────────────────────────────────────────────
test('半成品文件名不入库', () => {
  for (const n of ['.DSC1.JPG.ffpart', 'DSC1.JPG.part', 'DSC1.tmp', '~DSC1.JPG', '.DS_Store', '._DSC1.JPG', 'a.crdownload']) assert.equal(isIngestible(n), false, n);
  for (const n of ['DSC1.JPG', 'DSC1.ARW', 'C0001.MP4', 'x.heic']) assert.equal(isIngestible(n), true, n);
  assert.equal(isIngestible('notes.txt'), false);
  assert.equal(isPartialName('DSC1.JPG'), false);
});

test('稳定判定：两次一致且隔够静默时长', () => {
  const p = new StabilityPolicy(1000);
  assert.deepEqual(p.judge(null, null), { state: 'gone' });
  assert.equal(p.judge(null, { size: 5, mtimeMs: 1, at: 0 }).state, 'pending');
  assert.equal(p.judge({ size: 5, mtimeMs: 1, at: 0 }, { size: 9, mtimeMs: 2, at: 1000 }).state, 'pending', '还在长');
  assert.deepEqual(p.judge({ size: 5, mtimeMs: 1, at: 0 }, { size: 5, mtimeMs: 1, at: 400 }), { state: 'pending', recheckInMs: 600 });
  assert.equal(p.judge({ size: 0, mtimeMs: 1, at: 0 }, { size: 0, mtimeMs: 1, at: 2000 }).state, 'pending', '0 字节不算完');
  assert.equal(p.judge({ size: 5, mtimeMs: 1, at: 0 }, { size: 5, mtimeMs: 1, at: 1000 }).state, 'stable');
});

test('配对窗口：同目录最后一次到达后才放行', () => {
  const w = new PairingWindow(500);
  const f = (name, at, relDir = 'd') => ({ rootId: 'p', relDir, name, size: 1, at, source: 'ftp' });
  w.add(f('A.ARW', 0));
  w.add(f('A.JPG', 300));
  w.add(f('B.JPG', 100, 'e'));
  assert.equal(w.nextDueAt(), 600);
  assert.deepEqual(w.takeDue(700).map((d) => d.relDir), ['e']);
  const [d] = w.takeDue(800);
  assert.deepEqual(d.files.map((x) => x.name), ['A.ARW', 'A.JPG']);
  assert.equal(w.size, 0);
});

test('收件目录模板', () => {
  assert.equal(expandInboxDir('inbox/{date}', '2026-10-26'), 'inbox/2026-10-26');
  assert.equal(expandInboxDir('/cam/', 'x'), 'cam');
  assert.throws(() => expandInboxDir('../{date}', 'x'));
  assert.equal(inboxBase('inbox/{date}'), 'inbox');
  assert.equal(inboxBase('inbox/day-{date}'), 'inbox');
  assert.equal(inboxBase('{date}'), '');
  assert.equal(inboxBase('cam/a'), 'cam/a');
});

test('库事件：序号、补发与缺口', () => {
  const log = new LibraryEventLog({ capacity: 2 });
  const got = [];
  const off = log.subscribe((e) => got.push(e.seq));
  for (let i = 0; i < 3; i++) log.publish({ type: 'photos.added', rootId: 'p', relDir: '', photoIds: [`x${i}`], source: 'ftp' });
  off();
  assert.deepEqual(got, [1, 2, 3]);
  assert.deepEqual(log.since(2).events.map((e) => e.seq), [3]);
  assert.equal(log.since(2).gap, false);
  assert.equal(log.since(0).gap, true, '第 1 条已被挤出');
  assert.equal(log.since(3).gap, false);
});

// ── 编排（假时钟 + 假端口）─────────────────────────────────────────────────
function fakeClock() {
  let now = 0;
  let timers = [];
  return {
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => { timers = timers.filter((x) => x !== t); };
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

function harness(files) {
  const clock = fakeClock();
  const calls = [];
  const events = new LibraryEventLog();
  let sink;
  const svc = new IngestService({
    sources: [{ kind: 'watch', start: async (s) => { sink = s; }, stop: async () => undefined, status: () => ({}) }],
    catalog: { ingestDir: async (rootId, relDir) => { calls.push(`${rootId}/${relDir}`); return { added: [`id-${calls.length}`], updated: [] }; } },
    probe: { observe: async (_r, _d, name) => files.get(name) ?? null },
    events, clock,
  }, { stableMs: 1000, pairWindowMs: 500, maxWaitMs: 60_000 });
  return { svc, clock, calls, events, arrive: (name, complete = false) => sink.arrived({ rootId: 'p', relDir: 'inbox', name, complete }) };
}

test('写到一半的文件：一直长就一直等，停了才入库', async () => {
  const files = new Map([['DSC1.JPG', { size: 100, mtimeMs: 1 }]]);
  const h = harness(files);
  await h.svc.start();
  h.arrive('DSC1.JPG');
  for (let i = 2; i <= 5; i++) {
    await h.clock.advance(500);
    files.set('DSC1.JPG', { size: 100 * i, mtimeMs: i }); // 每次检查之间都在长
    await h.clock.advance(500);
  }
  // t=4000 最后一次看到变化；t=5000 才判稳定，再等配对窗口 500 → t=5500 入库
  await h.clock.advance(1400);
  assert.deepEqual(h.calls, [], '还没稳定 + 窗口没过');
  await h.clock.advance(200);
  assert.deepEqual(h.calls, ['p/inbox']);
  assert.equal(h.events.lastSeq, 1);
  assert.equal(h.svc.status().stats.ingested, 1);
  await h.svc.stop();
});

test('FTP 报完成：不观察；RAW+JPEG 在窗口内只入库一次', async () => {
  const files = new Map([['A.ARW', { size: 9, mtimeMs: 1 }], ['A.JPG', { size: 5, mtimeMs: 1 }]]);
  const h = harness(files);
  await h.svc.start();
  h.arrive('A.ARW', true);
  await h.clock.advance(300);
  h.arrive('A.JPG', true);
  await h.clock.advance(400);
  assert.deepEqual(h.calls, [], '窗口从最后一次到达算起');
  await h.clock.advance(200);
  assert.deepEqual(h.calls, ['p/inbox']);
  await h.svc.stop();
});

test('杂项与中途消失的不入库；一直在变超时放弃', async () => {
  const files = new Map([['GROW.JPG', { size: 1, mtimeMs: 1 }]]);
  const h = harness(files);
  const errors = [];
  h.svc.deps.onError = (t) => errors.push(t);
  await h.svc.start();
  h.arrive('readme.txt');
  h.arrive('.GONE.JPG.ffpart');
  h.arrive('GONE.JPG'); // probe 返回 null
  h.arrive('GROW.JPG');
  for (let i = 0; i < 70; i++) {
    files.set('GROW.JPG', { size: i + 2, mtimeMs: i + 2 });
    await h.clock.advance(1000);
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.svc.status().stats.ignored, 2);
  assert.equal(h.svc.status().stats.watching, 0);
  assert.match(h.svc.status().stats.lastError, /还在变/);
  await h.svc.stop();
});

// ── 端到端：目录监听 → 增量入库 → SSE ───────────────────────────────────────
function sse(port, cookie, qs = '') {
  const events = [];
  const waiters = [];
  const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/library/events${qs}`, headers: { cookie, origin: `http://127.0.0.1:${port}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
        for (const w of [...waiters]) w();
      }
    });
  });
  const until = (pred, ms = 15_000) => new Promise((resolve, reject) => {
    const check = () => { const hit = events.find(pred); if (hit) { resolve(hit); return true; } return false; };
    if (check()) return;
    const t = setTimeout(() => reject(new Error(`等不到事件：${JSON.stringify(events)}`)), ms);
    waiters.push(() => { if (check()) clearTimeout(t); });
  });
  return { events, until, close: () => req.destroy() };
}

test('目录监听端到端：分块写入的 RAW+JPEG 配成一张，SSE 推 photos.added', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ingest-'));
  const library = path.join(dir, 'lib');
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, 'OLD.jpg'), await jpeg(1));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    host: '127.0.0.1', port: 0, password: 'pw-ingest-test', dataDir: path.join(dir, 'data'), logLevel: 'silent',
    roots: [{ id: 'p', label: '入库', path: library }],
    ingest: { rootId: 'p', subdir: 'inbox/{date}', stableMs: 300, pairWindowMs: 300, watch: true },
  }));
  const cfg = loadConfig([`--config=${configFile}`]);
  const lib = new Library(cfg);
  await lib.refresh();
  const app = await buildServer(cfg, lib);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { password: 'pw-ingest-test' }, headers: { origin: 'http://ff.local', host: 'ff.local' } });
  const cookie = [login.headers['set-cookie']].flat()[0].split(';')[0];
  const stream = sse(port, cookie);
  try {
    await stream.until((e) => e.ev === 'ready');
    const caps = await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { cookie } });
    const ing = caps.json().ingest;
    assert.equal(ing.enabled, true);
    assert.match(ing.inbox, /^inbox\/\d{4}-\d{2}-\d{2}$/);
    const inbox = path.join(library, ...ing.inbox.split('/'));
    fs.mkdirSync(inbox, { recursive: true });
    // 分块慢写一个 JPEG（模拟 SMB/rsync 一点点写进来）
    const buf = await jpeg(200);
    const fd = fs.openSync(path.join(inbox, 'DSC9.JPG'), 'w');
    const half = Math.floor(buf.length / 2);
    fs.writeSync(fd, buf, 0, half);
    await new Promise((r) => setTimeout(r, 150));
    fs.writeSync(fd, buf, half, buf.length - half);
    fs.closeSync(fd);
    fs.writeFileSync(path.join(inbox, 'DSC9.ARW'), buf); // 同名 RAW（内容无所谓，配对看文件名）
    fs.writeFileSync(path.join(inbox, '.DSC10.JPG.ffpart'), buf); // 半成品：不该入库
    const added = await stream.until((e) => e.ev === 'photos.added');
    assert.equal(added.data.photoIds.length, 1, 'RAW+JPEG 配成一张');
    assert.equal(added.data.relDir, ing.inbox);
    assert.equal(added.data.source, 'watch');
    const photos = await app.inject({ method: 'GET', url: `/api/v1/photos?dir=${encodeURIComponent('/p')}&recursive=1&limit=50`, headers: { cookie } });
    const items = photos.json().items;
    const rec = items.find((x) => x.id === added.data.photoIds[0]);
    assert.ok(rec, '列表里有新照片');
    assert.equal(items.length, 2, '旧照片还在，半成品不在');
    // 重连带 Last-Event-ID：不重复补；since=0 则补发
    // 重连：since=0 补发漏掉的
    const replay = sse(port, cookie, '?since=0');
    try {
      const again = await replay.until((e) => e.ev === 'photos.added');
      assert.deepEqual(again.data.photoIds, added.data.photoIds);
    } finally { replay.close(); }
  } finally {
    stream.close();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
