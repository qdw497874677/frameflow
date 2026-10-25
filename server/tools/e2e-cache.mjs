#!/usr/bin/env node
/**
 * 预览缓存策略回归（票 013）。
 *
 *   node tools/e2e-cache.mjs
 *
 * 分两段：
 *  A. 直接测 `CacheJanitor`（不经过 HTTP）：淘汰顺序按 atime 从旧到新、删到上限的 90% 就停、
 *     单轮预算（truncated）、在途保护、半截 `.tmp` 清理、`maxBytes: 0` = 不动手、atime 刷新节流。
 *  B. 起一个**独立端口、独立数据目录**的服务实例（不动 dev.sh 那个）：`/capabilities.library.cache`
 *     能看见上限/占用/上一轮淘汰；预置超限的假缓存文件后，启动维护真的删掉了最旧的几个；
 *     索引里的 `lastScanAt` 过期时启动会补扫（`autoRescan.triggeredAt` 有值、`lastScanAt` 变新）；
 *     淘汰之后缩略图还能按需重建。
 *
 * 环境变量：CACHE_TEST_PORT（默认 8792）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CacheJanitor, touchIfStale } from '../src/adapters/outbound/fs/cache.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');
const PORT = Number(process.env.CACHE_TEST_PORT ?? 8792);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const CFG = '/tmp/artworks-cache-test.yaml';
const FIXTURE = '/tmp/artworks-cache-fixture';
const DATA_DIR = '/tmp/artworks-cache-data';
const LOG = '/tmp/artworks-cache-server.log';
const UNIT_DIR = '/tmp/artworks-cache-unit';
/** 小上限：5 个 100 KB 的假预览就超（400 KB 的 90% = 360 KB） */
const MAX_BYTES = 400_000;
const CHUNK = 100_000;

let pass = 0;
let fail = 0;

function check(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, init) {
  const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function startServer() {
  const fd = openSync(LOG, 'a');
  const child = spawn('node', ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ARTWORKS_CONFIG: CFG, ARTWORKS_LOG_LEVEL: 'info' },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child;
}

async function stopServer(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* 已经没了 */
  }
  await sleep(500);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* 已经没了 */
  }
}

async function waitUp(ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return Date.now() - t0;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  return -1;
}

/** 造一个 `size` 字节的文件，并把 atime/mtime 设到指定时刻 */
function makeFile(dir, name, size, atimeMs, mtimeMs = atimeMs) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(size, 7));
  const t = new Date(atimeMs);
  utimesSync(path, t, new Date(mtimeMs));
  return path;
}

const listDir = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const dirBytes = (dir) => listDir(dir).reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);

// ── A. CacheJanitor 直接测 ──────────────────────────────────────────────
console.log(`\n=== 预览缓存策略回归（票 013）===\n`);
console.log('  A. CacheJanitor（不经过 HTTP）');

rmSync(UNIT_DIR, { recursive: true, force: true });
const previews = join(UNIT_DIR, 'previews');
const thumbs = join(UNIT_DIR, 'thumbs');
mkdirSync(thumbs, { recursive: true });
const hour = 3_600_000;
const now = Date.now();
// f0 最旧 … f9 最新
for (let i = 0; i < 10; i++) makeFile(previews, `f${i}.jpg`, CHUNK, now - (10 - i) * hour);

const janitor = new CacheJanitor({ dirs: [previews, thumbs], maxBytes: 500_000 });
const first = await janitor.sweep();
check(first !== null, 'sweep 返回了结果');
check(first?.scanned === 10, '看到了 10 个文件', String(first?.scanned));
check(first?.deleted === 6, '删到 90% 就停（10 个 100KB / 上限 500KB → 删 6 个）', `deleted=${first?.deleted}`);
check(first?.freedBytes === 6 * CHUNK, '释放的字节数对得上', String(first?.freedBytes));
check(first?.bytes === 4 * CHUNK && first?.files === 4, '剩下的占用/文件数对得上', `${first?.bytes}B / ${first?.files}`);
const left = listDir(previews);
check(JSON.stringify(left) === JSON.stringify(['f6.jpg', 'f7.jpg', 'f8.jpg', 'f9.jpg']), '留下的是 atime 最新的 4 个', left.join(','));
check(janitor.stats().lastEvict?.at === first?.at, 'stats() 记得上一轮淘汰');

// 半截产物（进程崩在写盘中间）：不管超没超上限都要清
const tmpFile = makeFile(previews, 'half.jpg.999.tmp', CHUNK, now - 2 * hour, now - 2 * hour);
const second = await janitor.sweep();
check(!existsSync(tmpFile), '半截 .tmp 被清掉了');
check(second?.deleted === 1, '半截产物算进 deleted', String(second?.deleted));
check(second?.bytes === 4 * CHUNK && second?.files === 4, '半截产物不计入缓存占用/文件数', `${second?.bytes}B / ${second?.files}`);

// 在途保护：正在生成的预览不能删
const protectedPath = makeFile(previews, 'inflight.jpg', CHUNK, now - 20 * hour);
makeFile(previews, 'g1.jpg', CHUNK, now - 5 * hour);
makeFile(previews, 'g2.jpg', CHUNK, now - 4 * hour);
const guard = new CacheJanitor({ dirs: [previews, thumbs], maxBytes: 500_000, isProtected: (p) => p === protectedPath });
const third = await guard.sweep();
check(existsSync(protectedPath), '在途的那个没被删（哪怕它最旧）');
// 700KB 超 500KB：先跳在途的，再删 g1、g2 —— 还不够就继续删 f6（腾地方不能靠保护文件）
check(third?.deleted === 3, '超出部分删够（在途那份被跳过）', `deleted=${third?.deleted}`);
check((third?.bytes ?? 0) <= Math.floor(500_000 * 0.9), '删完压到上限的 90% 以下', `${third?.bytes}B`);

// 单轮预算：撞上 2000 的默认值不现实，这里用小预算验证 truncated
const budget = new CacheJanitor({ dirs: [previews, thumbs], maxBytes: 1, scanLimit: 3 });
const fourth = await budget.sweep();
check(fourth?.truncated === true && fourth?.scanned === 3, '单轮预算生效（truncated + 只看 3 个）', `scanned=${fourth?.scanned}`);

// 上限关着：什么都不碰
const before = dirBytes(previews);
const off = new CacheJanitor({ dirs: [previews, thumbs], maxBytes: 0 });
const fifth = await off.sweep();
check(fifth === null, 'maxBytes = 0 → sweep 不动手（返回 null）');
check(dirBytes(previews) === before, '关着上限时文件一个没少');

// atime 刷新：够旧才写，新的不写（relatime 下不刷就等于没有 LRU）
const stale = makeFile(previews, 'stale.jpg', CHUNK, now - 30 * hour);
const fresh = makeFile(previews, 'fresh.jpg', CHUNK, now - 60_000);
const freshAtimeBefore = statSync(fresh).atimeMs;
await touchIfStale(stale);
await touchIfStale(fresh);
check(Date.now() - statSync(stale).atimeMs < 5_000, '够旧的 atime 被刷新', `age=${Date.now() - statSync(stale).atimeMs}ms`);
check(statSync(fresh).atimeMs === freshAtimeBefore, '刚读过的 atime 不动（避免每条请求都写元数据）');

// ── B. 经过 HTTP 的整机验证 ────────────────────────────────────────────
console.log('\n  B. 服务实例（独立端口 / 独立数据目录）');
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(FIXTURE, { recursive: true, force: true });
mkdirSync(join(FIXTURE, '20260101-测试', '原照片'), { recursive: true });

// 一张真 JPEG（缩略图管线要能跑通，淘汰后还要能重建）
const sharp = (await import('sharp')).default;
await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3a4a5a' } })
  .jpeg()
  .toFile(join(FIXTURE, '20260101-测试', '原照片', 'a.jpg'));

// 预置 5 个 100 KB 的假预览（atime 从旧到新）→ 启动维护应该删掉最旧的
const livePreviews = join(DATA_DIR, 'previews');
for (let i = 0; i < 5; i++) makeFile(livePreviews, `seed${i}.jpg`, CHUNK, now - (5 - i) * hour);

writeFileSync(
  CFG,
  [
    'host: 127.0.0.1',
    `port: ${PORT}`,
    `dataDir: ${DATA_DIR}`,
    'password: ""',
    'logLevel: info',
    'scan:',
    '  autoRescanAfterDays: 1',
    'cache:',
    `  maxBytes: ${MAX_BYTES}`,
    'roots:',
    '  - id: cache',
    '    label: 缓存测试库',
    `    path: ${FIXTURE}`,
    '',
  ].join('\n'),
);

let child = startServer();
const up = await waitUp();
check(up >= 0, '服务起来了', `${up}ms`);

// 启动维护是后台跑的：等 lastEvict 出现
let cache = null;
for (let i = 0; i < 100; i++) {
  const { body } = await req('/capabilities');
  cache = body?.library?.cache ?? null;
  if (cache?.lastEvict) break;
  await sleep(100);
}
check(cache?.maxBytes === MAX_BYTES, '/capabilities 里能看到上限', String(cache?.maxBytes));
check(Boolean(cache?.lastEvict?.at), '启动维护记了一笔 lastEvict', String(cache?.lastEvict?.at));
check((cache?.lastEvict?.deleted ?? 0) >= 2, '超限的假预览被淘汰了', `deleted=${cache?.lastEvict?.deleted}`);
check(dirBytes(livePreviews) <= Math.floor(MAX_BYTES * 0.9), '删到上限的 90% 以下', `${dirBytes(livePreviews)}B`);
check(!existsSync(join(livePreviews, 'seed0.jpg')), '最旧的先被删');
check(cache?.files >= 1, '占用/文件数有值', `files=${cache?.files}`);

const lib1 = (await req('/capabilities')).body?.library ?? {};
check(lib1.autoRescan?.afterDays === 1, 'autoRescanAfterDays 进了 capabilities', String(lib1.autoRescan?.afterDays));
check(lib1.autoRescan?.triggeredAt === null, '索引是新的：启动没触发补扫', String(lib1.autoRescan?.triggeredAt));

// 淘汰之后缩略图照常按需重建（等首轮扫描把照片放进索引）
let photoId = null;
for (let i = 0; i < 150; i++) {
  const photos = await req('/photos?dir=%2Fcache%2F20260101-%E6%B5%8B%E8%AF%95%2F%E5%8E%9F%E7%85%A7%E7%89%87');
  photoId = photos.body?.items?.[0]?.id ?? null;
  if (photoId) break;
  await sleep(100);
}
check(Boolean(photoId), '扫描出了照片', String(photoId));
const thumb = await fetch(`${BASE}/photos/${photoId}/thumb?size=512`, { signal: AbortSignal.timeout(30_000) });
const thumbBytes = thumb.ok ? (await thumb.arrayBuffer()).byteLength : 0;
check(thumb.status === 200 && thumbBytes > 0, '淘汰后缩略图还能生成', `HTTP ${thumb.status} / ${thumbBytes}B`);

// 索引放旧（30 天）→ 重启就该补扫一次
await stopServer(child);
const indexPath = join(DATA_DIR, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
check(Array.isArray(index.records) && index.records.length > 0, '前置：索引里有记录', `${index.records?.length} 条`);
index.lastScanAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
writeFileSync(indexPath, JSON.stringify(index));

child = startServer();
const up2 = await waitUp();
check(up2 >= 0, '服务第二次起来', `${up2}ms`);
let auto = null;
let lastScanAt = null;
for (let i = 0; i < 150; i++) {
  const { body } = await req('/capabilities');
  auto = body?.library?.autoRescan ?? null;
  lastScanAt = body?.library?.lastScanAt ?? null;
  if (auto?.triggeredAt && lastScanAt && Date.now() - Date.parse(lastScanAt) < 60_000) break;
  await sleep(100);
}
check(Boolean(auto?.triggeredAt), '索引过期 → 启动补扫被记下（triggeredAt）', String(auto?.triggeredAt));
check(Boolean(lastScanAt) && Date.now() - Date.parse(lastScanAt) < 60_000, '补扫跑完，lastScanAt 变新', String(lastScanAt));

// ── 收尾 ───────────────────────────────────────────────────────────────
await stopServer(child);
const gone = await waitUp(1500);
check(gone < 0, '服务已停干净');
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(FIXTURE, { recursive: true, force: true });
rmSync(UNIT_DIR, { recursive: true, force: true });
check(!existsSync(DATA_DIR) && !existsSync(FIXTURE), '临时目录已清干净');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
