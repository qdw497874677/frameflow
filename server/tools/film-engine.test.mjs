/**
 * 光谱胶片引擎集成：领域规则、帧编解码、子进程适配器（超时 / 崩溃重启 / 协议校验）、
 * FilmLookSource 的缓存与降级、HTTP 接线与功能开关。
 * 用假引擎（tools/fake-film-engine.mjs）跑；若 FFE_ENGINE_BINARY + FFE_ENGINE_STOCKS 指向真引擎，再跑一遍真烘焙。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filmParamProblems, filmLookId, filmLutKey, lutFromEngine, filmEffectProblems, hasFilmEffects } from '../src/domain/grading/film.ts';
import { sampleLut } from '../src/domain/grading/lut.ts';
import { FilmLookSource } from '../src/application/grading/film-looks.ts';
import { CompositeLookSource } from '../src/application/grading/composite-looks.ts';
import { ProcessFilmEngine, FilmEnginePool, EngineError, encodeFrame, FrameDecoder, DirFilmLutStore } from '../src/adapters/film/index.ts';
import { parseFilm } from '../src/adapters/outbound/config-file.ts';
import { makeFixture } from './connector-fixture.mjs';

const FAKE = path.join(import.meta.dirname, 'fake-film-engine.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ff-film-'));
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const fakeEngine = (opts = {}) => new ProcessFilmEngine({ binary: process.execPath, args: [FAKE], timeoutMs: 2000, ...opts });

test('领域：参数范围、风格 id、缓存键、LUT 载荷', () => {
  assert.deepEqual(filmParamProblems({ exposureEv: 1, scanBlackPoint: false, dirStrength: 2 }), []);
  assert.equal(filmParamProblems({ exposureEv: 9 }).length, 1);
  assert.equal(filmParamProblems({ scanBlackPoint: 1 }).length, 1);
  assert.deepEqual(filmParamProblems({ inputGamma: 1, cameraFlare: 0.1 }), []);
  assert.equal(filmParamProblems({ inputGamma: 0.9 }).length, 1);
  assert.equal(filmParamProblems({ cameraFlare: 0.2 }).length, 1);
  assert.equal(filmParamProblems({ nope: 1 }).length, 1);
  assert.equal(filmLookId('Portrait-400'), 'filmportrait400');
  assert.equal(filmLutKey('v', 's', 'p', 33, { b: 1, a: 2 }), filmLutKey('v', 's', 'p', 33, { a: 2, b: 1 }));
  assert.notEqual(filmLutKey('v1', 's', 'p', 33, {}), filmLutKey('v2', 's', 'p', 33, {}));
  const lut = lutFromEngine(2, Float32Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? 1.5 : -0.2)));
  assert.equal(lut.table[0], 1);
  assert.equal(lut.table[1], 0);
  assert.throws(() => lutFromEngine(3, new Float32Array(10)));
});

test('帧编解码：往返、跨块拼接、坏魔数报错', () => {
  const a = encodeFrame({ op: 'x', n: 1 }, Uint8Array.from([1, 2, 3]));
  const b = encodeFrame({ op: 'y' });
  const both = Buffer.concat([a, b]);
  const d = new FrameDecoder();
  const frames = [];
  for (let i = 0; i < both.length; i += 5) frames.push(...d.push(both.subarray(i, i + 5)));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0].header, { op: 'x', n: 1 });
  assert.deepEqual([...frames[0].payload], [1, 2, 3]);
  assert.equal(frames[1].payload.length, 0);
  assert.throws(() => new FrameDecoder().push(Buffer.from('NOPE0000')));
});

test('适配器：懒启动握手、列胶片、烘焙、结构化错误、关闭', async () => {
  const e = fakeEngine();
  try {
    assert.equal(e.health().state, 'idle');
    const stocks = await e.stocks();
    assert.equal(e.health().state, 'up');
    assert.equal(e.version(), 'fake-1');
    assert.deepEqual(stocks.map((s) => s.kind), ['negative', 'paper']);
    const lut = await e.bakeLut({ stock: 'portrait400', size: 5 });
    assert.equal(lut.size, 5);
    near(sampleLut(lut, 0.25, 0.5, 1)[0], 0.75);
    await assert.rejects(e.bakeLut({ stock: 'nope', size: 3 }), (err) => err instanceof EngineError && err.code === 'unknown_stock');
    // 并发请求串行排队，都能拿到自己的结果
    const many = await Promise.all([3, 4, 5].map((size) => e.bakeLut({ stock: 'portrait400', size })));
    assert.deepEqual(many.map((l) => l.size), [3, 4, 5]);
  } finally { await e.close(); }
  assert.equal(e.health().state, 'down');
});

test('适配器：请求超时就杀掉进程，下个请求自动重启', async () => {
  await withEnv({ FAKE_FFE_MODE: 'hang-bake' }, async () => {
    const e = fakeEngine({ timeoutMs: 300 });
    try {
      await e.stocks();
      await assert.rejects(e.bakeLut({ stock: 'portrait400', size: 3 }), (err) => err.code === 'timeout');
      assert.equal(e.health().state, 'down');
      await e.stocks();
      assert.equal(e.health().state, 'up');
      assert.equal(e.health().restarts, 1);
    } finally { await e.close(); }
  });
});

test('适配器：崩溃后重启；连续崩溃熔断冷却；协议版本不对拒绝', async () => {
  const dir = tmp();
  await withEnv({ FAKE_FFE_MODE: 'crash-once', FAKE_FFE_MARK: path.join(dir, 'mark') }, async () => {
    const e = fakeEngine();
    try {
      await assert.rejects(e.bakeLut({ stock: 'portrait400', size: 3 }), (err) => err.code === 'down');
      const lut = await e.bakeLut({ stock: 'portrait400', size: 3 });
      assert.equal(lut.size, 3);
    } finally { await e.close(); }
  });
  let t = 0;
  const broken = new ProcessFilmEngine({ binary: path.join(dir, 'missing-binary'), maxCrashes: 2, cooldownMs: 1000, now: () => t });
  await assert.rejects(broken.stocks());
  await assert.rejects(broken.stocks());
  await assert.rejects(broken.stocks(), /冷却/);
  t = 5000;
  await assert.rejects(broken.stocks(), (err) => !/冷却/.test(err.message));
  await withEnv({ FAKE_FFE_MODE: 'proto2' }, async () => {
    const e = fakeEngine();
    try { await assert.rejects(e.stocks(), (err) => err.code === 'protocol'); } finally { await e.close(); }
  });
});

test('FilmLookSource：缓存优先、引擎挂了用旧缓存降级、目录也能从缓存来', async () => {
  const dataDir = tmp();
  const store = new DirFilmLutStore(dataDir);
  let calls = 0;
  let up = true;
  const engine = {
    version: () => (up ? 'v1' : null),
    health: () => ({ state: up ? 'up' : 'down', version: null, restarts: 0, lastError: null }),
    stocks: async () => { if (!up) throw new Error('down'); return [{ id: 'p4', name: 'P4', inspiredBy: '', kind: 'negative' }, { id: 'pp', name: 'PP', inspiredBy: '', kind: 'paper' }]; },
    bakeLut: async ({ size }) => { calls++; if (!up) throw new Error('down'); return lutFromEngine(size, new Float32Array(size ** 3 * 3).fill(0.5)); },
  };
  const src = new FilmLookSource(engine, store, { lutSize: 3 });
  assert.deepEqual(await src.refresh(), { from: 'engine' });
  assert.deepEqual(src.list().map((l) => l.id), ['filmp4']);
  assert.equal(await src.load('nope'), null);
  const [a, b] = await Promise.all([src.load('filmp4'), src.load('filmp4')]);
  assert.equal(calls, 1, '并发同一风格只烘焙一次');
  assert.equal(a, b);
  // 新实例（重启）：命中磁盘缓存，不再烘焙
  const again = new FilmLookSource(engine, store, { lutSize: 3 });
  await again.refresh();
  near((await again.load('filmp4')).table[0], 0.5);
  assert.equal(calls, 1);
  // 引擎挂了：目录和 LUT 都从缓存来
  up = false;
  const offline = new FilmLookSource(engine, store, { lutSize: 3 });
  assert.equal((await offline.refresh()).from, 'cache');
  assert.equal(offline.list().length, 1);
  near((await offline.load('filmp4')).table[0], 0.5);
  // 参数不同又没有缓存：拿不到
  const other = new FilmLookSource(engine, store, { lutSize: 3, params: { exposureEv: 1 } });
  await other.refresh();
  assert.equal(await other.load('filmp4'), null);
  // 合成来源：前面的来源优先，id 不重复
  const composite = new CompositeLookSource([{ kind: 'a', source: { list: () => [{ id: 'filmp4', name: 'x', inspiredBy: '' }], load: async () => null } }, { kind: 'film', source: offline }]);
  assert.deepEqual(composite.entries().map((l) => l.kind), ['a']);
});

test('配置：功能开关缺省关', () => {
  assert.equal(parseFilm(undefined, {}), null);
  assert.equal(parseFilm({ enabled: false }, { ARTWORKS_FILM_ENABLED: '1' }), null);
  const on = parseFilm(undefined, { ARTWORKS_FILM_ENABLED: '1' });
  assert.equal(on.lutSize, 33);
  assert.match(on.binary, /engine[\\/]build[\\/]frameflow-film$/);
  assert.throws(() => parseFilm({ enabled: true, lutSize: 200 }, {}));
});

test('HTTP：开关关着与以前一样；打开后 film 风格出现在列表并能取 .cube、状态可查', async () => {
  const off = await makeFixture({ photos: 0 });
  try {
    assert.deepEqual((await off.call('GET', '/api/v1/film/status')).json, { enabled: false });
    assert.ok((await off.call('GET', '/api/v1/looks')).json.items.every((l) => l.kind === 'cube'));
  } finally { await off.dispose(); }

  const bin = path.join(tmp(), 'ffe');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  await withEnv({ ARTWORKS_FILM_ENABLED: '1', ARTWORKS_FILM_BINARY: bin, FAKE_FFE_MODE: 'ok' }, async () => {
    const fx = await makeFixture({ photos: 1 });
    try {
      const status = (await fx.call('GET', '/api/v1/film/status')).json;
      assert.equal(status.enabled, true);
      assert.equal(status.engine.state, 'up');
      assert.equal(status.catalog, 'engine');
      const items = (await fx.call('GET', '/api/v1/looks')).json.items;
      const film = items.find((l) => l.id === 'filmportrait400');
      assert.equal(film.kind, 'film');
      assert.ok(items.some((l) => l.id === 'portrait400' && l.kind === 'cube'), '同名 .cube 风格不受影响');
      const cube = await fx.call('GET', '/api/v1/looks/filmportrait400.cube');
      assert.equal(cube.status, 200);
      assert.match(cube.text, /LUT_3D_SIZE 33/);
      assert.ok(fs.readdirSync(path.join(fx.dataDir, 'cache', 'film-luts')).some((f) => f.endsWith('.cube')));
      const plan = await fx.call('POST', '/api/v1/jobs', { kind: 'grade', selection: {}, params: { look: 'filmportrait400' }, mode: 'plan' });
      assert.equal(plan.status, 201, 'grade 任务认得 film 风格');
    } finally { await fx.dispose(); }
  });
});

test('领域：整帧效果参数', () => {
  assert.deepEqual(filmEffectProblems({ grain: 1, grainSeed: 7, halation: 0.2, halationRadiusMm: 0.3, dirDiffusionUm: 10, filmFormatMm: 36 }), []);
  assert.equal(filmEffectProblems({ grain: 5 }).length, 1);
  assert.equal(filmEffectProblems({ grainSeed: 1.5 }).length, 1);
  assert.equal(filmEffectProblems({ exposureEv: 1 }).length, 1, 'LUT 参数不算效果');
  assert.equal(hasFilmEffects({}), false);
  assert.equal(hasFilmEffects({ grain: 0, halation: 0, filmFormatMm: 60 }), false);
  assert.equal(hasFilmEffects({ halation: 0.1 }), true);
});

test('帧编解码：几十 MB 载荷按小块推进来也是线性时间', () => {
  const big = new Uint8Array(48 * 1024 * 1024);
  big[big.length - 1] = 7;
  const f = encodeFrame({ op: 'render' }, big);
  const d = new FrameDecoder();
  const t0 = Date.now();
  const got = [];
  for (let i = 0; i < f.length; i += 65536) got.push(...d.push(f.subarray(i, i + 65536)));
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.length, big.length);
  assert.equal(got[0].payload[big.length - 1], 7);
  assert.ok(Date.now() - t0 < 3000, `解帧用了 ${Date.now() - t0} ms`);
});

test('进程池：整帧渲染、参数透传、按像素定超时、内存闸门、超限拒绝', async () => {
  const pool = new FilmEnginePool([fakeEngine(), fakeEngine()], { baseMs: 1000, msPerMp: 500, memoryBytes: 64 * 100 * 1.5, maxMegapixels: 1 });
  try {
    assert.equal(pool.timeoutFor(6000, 3000), 1000 + 500 * 18);
    const px = Uint8Array.from({ length: 10 * 10 * 3 }, (_, i) => i % 256);
    const out = await pool.render({ stock: 'portrait400', width: 10, height: 10, pixels: px, params: { grain: 1 } });
    assert.equal(out[5], 255 - px[5] + 1);
    // 预算只够一张 100 像素的：两个进程也只能一张一张来
    let peak = 0;
    const origin = pool.health.bind(pool);
    const runs = Array.from({ length: 4 }, () => pool.render({ stock: 'portrait400', width: 10, height: 10, pixels: px }).then(() => { peak = Math.max(peak, origin().renders.active); }));
    assert.equal(pool.health().renders.active, 1);
    assert.equal(pool.health().renders.queued, 3);
    await Promise.all(runs);
    assert.equal(pool.health().renders.done, 5);
    await assert.rejects(pool.render({ stock: 'portrait400', width: 2000, height: 1000, pixels: new Uint8Array(6e6) }), (e) => e.code === 'too_large');
    await assert.rejects(pool.render({ stock: 'portrait400', width: 3, height: 3, pixels: new Uint8Array(5) }), (e) => e.code === 'bad_request');
  } finally { await pool.close(); }
});

test('进程池：渲染挂住按超时杀进程，下一次重新拉起', async () => {
  await withEnv({ FAKE_FFE_MODE: 'hang-render' }, async () => {
    const pool = new FilmEnginePool([fakeEngine()], { baseMs: 300, msPerMp: 0.001 });
    try {
      const px = new Uint8Array(12);
      await assert.rejects(pool.render({ stock: 'portrait400', width: 2, height: 2, pixels: px }), (e) => e.code === 'timeout');
      assert.equal(pool.health().renders.failed, 1);
      assert.equal(pool.health().renders.active, 0, '超时后闸门要释放');
      assert.ok((await pool.stocks()).length > 0, '超时后能重启');
    } finally { await pool.close(); }
  });
});

test('配置：整帧渲染进程池缺省与校验', () => {
  const on = parseFilm({ enabled: true }, {});
  assert.deepEqual(on.render, { workers: 1, baseMs: 20000, msPerMp: 2000, memoryMb: 3072, maxMegapixels: 100 });
  assert.equal(parseFilm({ enabled: true, render: { workers: 2 } }, {}).render.workers, 2);
  assert.throws(() => parseFilm({ enabled: true, render: { workers: 0 } }, {}));
  assert.throws(() => parseFilm({ enabled: true, render: { memoryMb: -1 } }, {}));
});

const REAL = process.env.FFE_ENGINE_BINARY;
test('真引擎：整帧渲染带颗粒，同种子一致、不同种子不同', { skip: !REAL && '没设 FFE_ENGINE_BINARY' }, async () => {
  const pool = new FilmEnginePool([new ProcessFilmEngine({ binary: REAL, args: ['--data', process.env.FFE_ENGINE_STOCKS ?? ''] })]);
  try {
    const w = 64, h = 48;
    const px = Uint8Array.from({ length: w * h * 3 }, (_, i) => 60 + (i % (w * 3)) % 120);
    const req = { stock: 'portrait400', width: w, height: h, pixels: px };
    const plain = await pool.render(req);
    const a = await pool.render({ ...req, params: { grain: 2, grainSeed: 3, filmFormatMm: 8 } });
    const b = await pool.render({ ...req, params: { grain: 2, grainSeed: 3, filmFormatMm: 8 } });
    const c = await pool.render({ ...req, params: { grain: 2, grainSeed: 4, filmFormatMm: 8 } });
    assert.equal(a.length, w * h * 3);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.notDeepEqual(a, plain);
  } finally { await pool.close(); }
});

test('真引擎：烘焙 9³ LUT，灰轴中性', { skip: !REAL && '没设 FFE_ENGINE_BINARY' }, async () => {
  const e = new ProcessFilmEngine({ binary: REAL, args: ['--data', process.env.FFE_ENGINE_STOCKS ?? ''], timeoutMs: 60_000 });
  try {
    const stocks = await e.stocks();
    const neg = stocks.find((s) => s.kind === 'negative');
    const lut = await e.bakeLut({ stock: neg.id, size: 9 });
    for (const v of [0.25, 0.5, 0.75]) {
      const [r, g, b] = sampleLut(lut, v, v, v);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 0.03, `灰 ${v} → ${r} ${g} ${b}`);
    }
    const lo = sampleLut(lut, 0.3, 0.3, 0.3)[1], hi = sampleLut(lut, 0.7, 0.7, 0.7)[1];
    assert.ok(hi > lo);
  } finally { await e.close(); }
});
