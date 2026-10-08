#!/usr/bin/env node
/**
 * 项目目录生命周期回归（「绑定的目录找不到了怎么办」）：
 * 一个项目从 在线 → 目录没了（离线） → 移除 → 重新添加 → 标注接上，
 * 以及目录回来后不点重扫、靠巡检自动恢复。
 *
 *   node tools/e2e-root-lifecycle.mjs
 *
 * 端口 8794，独立数据目录 /tmp/artworks-lifecycle-data，测试照片库 /tmp/artworks-lifecycle-lib。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const CFG = '/tmp/artworks-lifecycle.yaml';
const DATA_DIR = '/tmp/artworks-lifecycle-data';
const LIB = '/tmp/artworks-lifecycle-lib';
const LOG = '/tmp/artworks-lifecycle-server.log';
const TOUR_MS = 1500; // 巡检间隔（环境变量喂给服务进程）

// 测试库里两张现成 JPEG（有 EXIF，能正常配对/缩略）
const SRC = [
  '/home/qdw/Pictures/artworks-test/20240131-松下试机/松下GX1/原照片/_1110316.JPG',
  '/home/qdw/Pictures/artworks-test/20230215-福马400/奥林巴斯XA/处理后照片/lr-04567.jpg',
];

let pass = 0;
let fail = 0;
function check(ok, name, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 204 等 */ }
  return { status: res.status, body };
}

function seedLib() {
  rmSync(LIB, { recursive: true, force: true });
  mkdirSync(LIB, { recursive: true });
  copyFileSync(SRC[0], join(LIB, '_1110316.JPG'));
  copyFileSync(SRC[1], join(LIB, 'lr-04567.jpg'));
}

function startServer() {
  const fd = openSync(LOG, 'a');
  const child = spawn('node', ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ARTWORKS_CONFIG: CFG, ARTWORKS_TOUR_MS: String(TOUR_MS), ARTWORKS_LOG_LEVEL: 'info' },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child;
}

async function stopServer(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已经没了 */ }
  await sleep(400);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 收干净了 */ }
}

async function waitUp(ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  return false;
}

async function waitScanChange(prev, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { body } = await req('/capabilities');
    const at = body?.library?.lastScanAt ?? null;
    if (at && at !== prev) return at;
    await sleep(80);
  }
  return null;
}

async function rootState(id) {
  const { body } = await req('/roots');
  return (body?.roots ?? []).find((r) => r.id === id) ?? null;
}

console.log(`\n=== 项目目录生命周期回归：${BASE} ===\n`);
console.log(`  测试照片库 ${LIB}（两张 JPEG）\n  巡检间隔 ${TOUR_MS}ms，独立数据目录 ${DATA_DIR}\n`);

for (const f of SRC) {
  if (!existsSync(f)) {
    console.error(`源照片不在：${f}（先跑 tools/make-fixture.mjs）`);
    process.exit(2);
  }
}

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
seedLib();
writeFileSync(
  CFG,
  [
    'host: 127.0.0.1',
    `port: ${PORT}`,
    `dataDir: ${DATA_DIR}`,
    'password: ""',
    'logLevel: info',
    'roots:',
    '  - id: life',
    '    label: 生命周期盘',
    `    path: ${LIB}`,
    'scan:',
    '  maxDepth: 8',
    '  rootTimeoutMs: 3000',
    '',
  ].join('\n'),
  'utf8',
);

try {
  await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
  console.error(`端口 ${PORT} 上已经有服务在跑，先停掉它再跑本脚本`);
  process.exit(2);
} catch { /* 空的，正合期望 */ }

// ── 1. 在线：两张照片，打一颗星 ────────────────────────────────────────
let child = startServer();
check(await waitUp(), '服务起来了');
let scanAt = (await req('/capabilities')).body?.library?.lastScanAt ?? null;
await req('/scan', { method: 'POST' });
scanAt = await waitScanChange(scanAt);
check(scanAt !== null, '首轮扫描跑完');

const listed = await req('/photos?dir=/life');
check(listed.body?.items?.length === 2, '两张照片都在', `n=${listed.body?.items?.length ?? 0}`);
const A = listed.body?.items?.[0];
check(!!A?.id, '拿到照片 A 的 id', A?.id?.slice(0, 24) ?? '');

const mark1 = await req('/marks', { method: 'PUT', body: JSON.stringify({ items: [{ id: A.id, stars: 3 }] }) });
check(mark1.status === 200, '给 A 打 3★');
const marked = (await req('/photos?dir=/life')).body?.items?.find((p) => p.id === A.id);
check(marked?.stars === 3, '列表读回 3★', `stars=${marked?.stars}`);

// ── 2. 目录没了：离线、不出鬼片、标注账还在 ────────────────────────────
rmSync(LIB, { recursive: true, force: true });
await req('/scan', { method: 'POST' });
scanAt = await waitScanChange(scanAt);
check(scanAt !== null, '目录没了之后的扫描收场了');
let life = await rootState('life');
check(life?.online === false, '项目标成离线', `online=${life?.online}`);
check((life?.lastError ?? '').includes('ENOENT') || (life?.lastError ?? '').includes('读不了目录'), '原因说清目录读不了', (life?.lastError ?? '').slice(0, 60));
check(life?.photoCount === 0, 'photoCount 归 0', `photoCount=${life?.photoCount}`);
const ghost = await req('/photos?dir=/life');
check((ghost.body?.items ?? []).length === 0, '离线项目不出鬼照片');
const marksLog = readFileSync(join(DATA_DIR, 'marks.jsonl'), 'utf8');
check(marksLog.includes(A.id), '标注账（marks.jsonl）里 A 还在 —— 没丢');

// ── 3. 离线也能移除；移除后目录不在时加不回去 ─────────────────────────
check((await req('/roots/life', { method: 'DELETE' })).status === 204, '离线项目能移除（只解除映射）');
check((await rootState('life')) === null, '移除后列表里没有它了');
const addMissing = await req('/roots', { method: 'POST', body: JSON.stringify({ path: LIB, label: '生命周期盘' }) });
check(addMissing.status === 404, '目录不存在时重新添加被拒绝（说清访问不到）', addMissing.body?.error?.slice(0, 50) ?? `HTTP ${addMissing.status}`);

// ── 4. 目录回来了再添加：id 复用，标注接上 ────────────────────────────
seedLib();
const readd = await req('/roots', { method: 'POST', body: JSON.stringify({ path: LIB }) });
check(readd.status === 201, '重新添加成功（不带 label 也能加）');
check(readd.body?.root?.id === 'life', 'id 用回了原来的 life（墓碑生效）', `id=${readd.body?.root?.id}`);
scanAt = (await req('/capabilities')).body?.library?.lastScanAt ?? null;
scanAt = await waitScanChange(scanAt);
life = await rootState('life');
check(life?.online === true && life?.photoCount === 2, '重新在线、照片回来了', `online=${life?.online} n=${life?.photoCount}`);
const back = (await req('/photos?dir=/life')).body?.items?.find((p) => p.id === A.id);
check(!!back, 'A 的 id 没变（同目录同文件名）');
check(back?.stars === 3, 'A 的 3★ 接上了（id 复用的意义所在）', `stars=${back?.stars}`);

// ── 5. 重启后标注仍然在（marks.jsonl 重放） ────────────────────────────
await stopServer(child);
child = startServer();
check(await waitUp(), '重启起来了');
await req('/scan', { method: 'POST' });
const afterBoot = (await req('/photos?dir=/life')).body?.items?.find((p) => p.id === A.id);
check(afterBoot?.stars === 3, '重启后 3★ 还在（重放标注账）', `stars=${afterBoot?.stars}`);

// ── 6. 目录又没了 → 回来，不点重扫：巡检自动恢复 ───────────────────────
rmSync(LIB, { recursive: true, force: true });
await req('/scan', { method: 'POST' });
scanAt = await waitScanChange(scanAt);
life = await rootState('life');
check(life?.online === false, '目录又没了 → 再度离线');
seedLib(); // 回来了，但什么都不点
let recovered = null;
const t0 = Date.now();
while (Date.now() - t0 < 15_000) {
  life = await rootState('life');
  if (life?.online === true) { recovered = life; break; }
  await sleep(400);
}
check(recovered !== null, '巡检探到目录回来了，自动补扫上线', recovered ? `${Math.round((Date.now() - t0) / 100) / 10}s 内` : '15s 没恢复');
scanAt = await waitScanChange(scanAt);
life = await rootState('life');
check(life?.photoCount === 2, '自动补扫把照片数找回来了', `photoCount=${life?.photoCount}`);

// ── 收摊 ────────────────────────────────────────────────────────────────
await stopServer(child);
rmSync(LIB, { recursive: true, force: true });
rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(CFG, { force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
