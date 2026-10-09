#!/usr/bin/env node
/**
 * 冷启动回归：重启后**先吃索引缓存**，扫描还没跑完就能服务照片列表。
 *
 *   node tools/e2e-cold-start.mjs [base]
 *
 * 断言：
 *   ① 重启后很快就能列出某个目录的照片；
 *   ② 强判定：拿到照片的那一刻 `library.scanning` 仍是 true
 *      —— 这批照片不可能来自这次扫描，只能是 index.json（扫描太快抓不到窗口时降级为弱判定并提示）；
 *   ③ 服务日志（只看重启之后新写的那段）里有「索引缓存已就绪」。
 * 前提：数据目录里已有扫完的索引（本脚本会先触发一次扫描并等它跑完，顺手把索引写好）。
 * 环境变量：SKIP_RESTART=1 跳过 dev.sh restart（对「刚刚手动重启过」的进程做验证）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/api/v1';
const LOG = process.env.ARTWORKS_LOG ?? '/tmp/artworks-server.log';
const SKIP_RESTART = process.env.SKIP_RESTART === '1';

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
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const libOf = (caps) => caps.body?.library ?? {};

/** 找一个「直属有照片」的目录（走缓存的目录树，扫一遍就够） */
async function findDirWithPhotos() {
  const roots = await req('/roots');
  const queue = (roots.body?.roots ?? []).filter((r) => (r.photoCount ?? 0) > 0).map((r) => r.path);
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const p = await req(`/photos?dir=${encodeURIComponent(dir)}&limit=1`);
    if ((p.body?.items?.length ?? 0) > 0) return dir;
    const f = await req(`/folders?path=${encodeURIComponent(dir)}`);
    for (const kid of f.body?.folders ?? []) queue.push(kid.path);
  }
  return null;
}

// ── 前置：确保盘上有一份扫完的索引，并挑好一个用来问列表的目录 ──────────
let caps = await req('/capabilities');
check(caps.status === 200, 'GET /capabilities', `HTTP ${caps.status}`);
if (!libOf(caps).photos) {
  await req('/scan', { method: 'POST' });
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    caps = await req('/capabilities');
    if (!libOf(caps).scanning) break;
  }
}
const before = libOf(caps).photos ?? 0;
check(before > 0, '前置：索引里已有照片', `${before} 张`);
const dir = await findDirWithPhotos();
check(dir !== null, '前置：找到了有照片的目录', dir ?? '');

// ── 前置 2：把一张标成待删（重启后必须还查得到 —— 真值在 marks 日志里，不在索引基线里）──
const json = (b) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const putMarks = (items) => req('/marks', { method: 'PUT', ...json({ items }) });
const probe = dir ? ((await req(`/photos?dir=${encodeURIComponent(dir)}&limit=1`)).body?.items?.[0] ?? null) : null;
check(Boolean(probe), '前置：挑到一张用于验证标注持久化', probe?.displayName ?? 'none');
if (probe) {
  const marked = await putMarks([{ id: probe.id, del: true }]);
  check(marked.status === 200, '前置：标成待删', `HTTP ${marked.status}`);
}

// ── 重启（只关心重启之后新写的那段日志）────────────────────────────────
let logOffset = 0;
try {
  logOffset = statSync(LOG).size;
} catch {
  logOffset = 0;
}
if (SKIP_RESTART) {
  console.log('  --   跳过重启（SKIP_RESTART=1）');
} else {
  execFileSync(join(HERE, 'dev.sh'), ['restart'], { cwd: join(HERE, '..'), stdio: 'pipe' });
}

// ── 重启后立刻轮询：照片必须在扫描跑完之前就能列出来 ─────────────────────
const startedAt = Date.now();
const deadline = startedAt + 8000;
let first = null; // { ms, count, scanning }
let sawScanning = false;
let lastErr = '';

while (Date.now() < deadline && dir) {
  try {
    const [c, p] = await Promise.all([req('/capabilities'), req(`/photos?dir=${encodeURIComponent(dir)}&limit=1`)]);
    const scanning = libOf(c).scanning === true;
    if (scanning) sawScanning = true;
    const count = p.body?.items?.length ?? 0;
    if (count > 0) {
      first = { ms: Date.now() - startedAt, count, scanning };
      break;
    }
  } catch (err) {
    lastErr = String(err?.cause?.code ?? err?.message ?? err);
  }
  await sleep(10);
}

check(first !== null, '重启后能列出照片', first ? `${first.count} 张 / ${first.ms}ms` : `超时${lastErr ? `（${lastErr}）` : ''}`);
check(
  first !== null && first.scanning,
  '照片是在扫描跑完之前端出来的（强判定：吃的是缓存）',
  first ? (first.scanning ? `scanning=true @${first.ms}ms` : '未抓到 scanning 窗口，降级为弱判定') : '',
);
if (first && !first.scanning && !sawScanning) {
  console.log('  --   提示：本轮扫描太快（没看到 scanning=true），强判定无法生效；日志断言仍然有效');
}

// ── 日志：确认走了缓存恢复这条分支 ─────────────────────────────────────
let fresh = '';
try {
  // dev.sh 启动时用 `>` 截断日志，所以重启后文件可能比重启前还短 —— 那就整篇看
  const size = statSync(LOG).size;
  const from = size <= logOffset ? 0 : logOffset;
  fresh = readFileSync(LOG, 'utf8').slice(Math.max(from, size - 2_000_000));
} catch {
  /* 日志不在就算了，下面会 FAIL */
}
check(/索引缓存已就绪/.test(fresh), '重启后的日志有「索引缓存已就绪」', `${fresh.length} 字节新日志`);

// ── 重启后：标过的照片仍然查得到（回归：重启后 sel=del 空手而归）────────────
if (probe && dir) {
  const delList = await req(`/photos?dir=${encodeURIComponent(dir)}&sel=del&limit=200`);
  check(
    (delList.body?.items ?? []).some((p) => p.id === probe.id),
    '重启后 sel=del 仍能查到标过的照片（真值来自 marks 日志）',
    `${delList.body?.total ?? 0} 张待删`,
  );
  const plain = await req(`/photos?dir=${encodeURIComponent(dir)}&limit=200`);
  check(!(plain.body?.items ?? []).some((p) => p.id === probe.id), '默认列表里仍然滤掉待删');
  const undone = await putMarks([{ id: probe.id, stars: 0, del: false }]);
  check(undone.status === 200, '收尾：把待删标记清掉', `HTTP ${undone.status}`);
}

// 收尾：等这次补扫跑完，别把下次测试挂在半扫描状态上
for (let i = 0; i < 600; i++) {
  const c = await req('/capabilities');
  if (!libOf(c).scanning) break;
  await sleep(100);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
