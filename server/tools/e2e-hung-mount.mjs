#!/usr/bin/env node
/**
 * 挂载失联回归（票 011）：一个根的网络挂载卡死时，服务必须**照样能用**。
 *
 *   node tools/e2e-hung-mount.mjs
 *
 * 它自己起一个**独立端口、独立数据目录**的服务实例（不动 dev.sh 那个），用
 * `ARTWORKS_TEST_HANG_ROOT=<rootId>` 让某个根在扫描时「永远不返回」——这是扫描器里的
 * 测试钩子（`server/src/core/scan.ts` 的 `fakeHang()`），比真去拔网线稳定得多。
 *
 * 断言：
 *   ① 挂死根卡住的那几秒里，`/health`、`/roots`、`/photos` 仍然秒回（服务没被冻住）；
 *   ② 挂死根的扫描按超时收场（`library.scanning` 会回到 false，不会永远 scanning）；
 *   ③ 该根被标成 offline + `lastError` 说清是超时，**另一个根照常在线、照样有照片**；
 *   ④ 冷却期生效：排队补扫会跳过刚超时的根（毫秒级，而不是再等一个超时）。
 *
 * 环境变量：ARTWORKS_TEST_ROOT（默认 /home/qdw/Pictures/artworks-test）、HANG_TEST_PORT（默认 8788）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');
const FIXTURE = process.env.ARTWORKS_TEST_ROOT ?? '/home/qdw/Pictures/artworks-test';
const PORT = Number(process.env.HANG_TEST_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const CFG = '/tmp/artworks-hang-test.yaml';
const DATA_DIR = '/tmp/artworks-hang-data';
const LOG = '/tmp/artworks-hang-server.log';
const ROOT_TIMEOUT_MS = 3000;

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

function startServer(hangRoot) {
  const fd = openSync(LOG, 'a');
  const child = spawn('node', ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ARTWORKS_CONFIG: CFG,
      ARTWORKS_TEST_HANG_ROOT: hangRoot ?? '',
      ARTWORKS_LOG_LEVEL: 'info',
    },
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

async function waitLastScanChange(prev, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { body } = await req('/capabilities');
    const at = body?.library?.lastScanAt ?? null;
    if (at && at !== prev) return { ms: Date.now() - t0, value: at };
    await sleep(60);
  }
  return null;
}

console.log(`\n=== 挂载失联回归（票 011）：${BASE} ===\n`);
console.log(`  测试库 ${FIXTURE}\n  超时闸 ${ROOT_TIMEOUT_MS}ms，独立数据目录 ${DATA_DIR}\n`);

if (!existsSync(FIXTURE)) {
  console.error(`测试库不在：${FIXTURE}（先跑 tools/make-fixture.mjs）`);
  process.exit(2);
}

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  CFG,
  [
    'host: 127.0.0.1',
    `port: ${PORT}`,
    `dataDir: ${DATA_DIR}`,
    'password: ""',
    'logLevel: info',
    'roots:',
    '  - id: test',
    '    label: 本机测试库',
    `    path: ${FIXTURE}`,
    '  - id: hang',
    '    label: 失联盘',
    `    path: ${FIXTURE}`,
    'scan:',
    '  maxDepth: 8',
    `  rootTimeoutMs: ${ROOT_TIMEOUT_MS}`,
    '',
  ].join('\n'),
  'utf8',
);

// 端口不能被占（免得对着别的实例做断言）
try {
  await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
  console.error(`端口 ${PORT} 上已经有服务在跑，先停掉它再跑本脚本`);
  process.exit(2);
} catch {
  /* 空的，正合期望 */
}

// ── 1. 预热：不带挂死钩子跑一次完整扫描，把索引写好 ─────────────────────
let child = startServer(null);
check((await waitUp()) >= 0, '预热轮服务起来了');
const warmBefore = (await req('/capabilities')).body?.library?.lastScanAt ?? null;
await req('/scan', { method: 'POST' });
const warm = await waitLastScanChange(warmBefore);
check(warm !== null, '预热扫描跑完（索引已就绪）', warm ? `${warm.ms}ms` : '');
await stopServer(child);

// ── 2. 挂死轮：启动即扫，hang 根永远不返回 ─────────────────────────────
child = startServer('hang');
const upMs = await waitUp();
check(upMs >= 0, '挂死轮服务起来了', `${upMs}ms`);

// 扫描正卡在挂死根上时再点一次「重扫」——这一下必须是「排队」，不能新开一轮
const before = (await req('/capabilities')).body?.library?.lastScanAt ?? null;
const queued = await req('/scan', { method: 'POST' });
check(
  queued.status === 202 && queued.body?.started === false && queued.body?.queued === true,
  '扫描中再点重扫 → 排队补扫一次',
  `HTTP ${queued.status} ${JSON.stringify(queued.body)}`,
);

// 挂死窗口内：其它接口必须秒回
let worst = 0;
let worstPath = '';
for (const path of ['/health', '/roots', '/photos?dir=/test&limit=1', '/capabilities']) {
  const t0 = Date.now();
  const r = await req(path);
  const ms = Date.now() - t0;
  if (ms > worst) {
    worst = ms;
    worstPath = path;
  }
  check(r.status === 200, `挂死期间 ${path} 正常响应`, `${ms}ms`);
}
check(worst < 1500, '挂死期间没有请求被冻住', `最慢 ${worst}ms（${worstPath}）`);

const first = await waitLastScanChange(before, ROOT_TIMEOUT_MS * 5);
check(first !== null, '挂死根的扫描按超时收场（没有永远 scanning）', first ? `${first.ms}ms` : '没等到');
check(first !== null && first.ms < ROOT_TIMEOUT_MS * 3, '没有拖过好几个超时窗口', first ? `${first.ms}ms` : '');

const roots = await req('/roots');
const hangRoot = roots.body?.roots?.find((r) => r.id === 'hang');
const testRoot = roots.body?.roots?.find((r) => r.id === 'test');
check(hangRoot?.online === false, '失联的根标成 offline');
check(
  typeof hangRoot?.lastError === 'string' && hangRoot.lastError.includes('超时'),
  'lastError 说清是超时',
  String(hangRoot?.lastError),
);
check(
  testRoot?.online === true && Number(testRoot?.photoCount) > 0,
  '另一个根照常在线、有照片',
  `online=${testRoot?.online} photoCount=${testRoot?.photoCount}`,
);

// ── 3. 冷却期：排队的那轮补扫应跳过刚超时的根 ──────────────────────────
const second = await waitLastScanChange(first?.value ?? '', ROOT_TIMEOUT_MS * 5);
check(second !== null, '排队补扫跑完了');
check(second !== null && second.ms < ROOT_TIMEOUT_MS, '冷却期生效：补扫跳过失联的根，不再等一个超时', second ? `${second.ms}ms` : '');
const caps = await req('/capabilities');
const skipNote = (caps.body?.library?.errors ?? []).find((e) => String(e).includes('跳过'));
check(typeof skipNote === 'string', '错误列表里说明了跳过的根', String(skipNote));

// ── 4. 收尾：服务能正常停 ──────────────────────────────────────────────
await stopServer(child);
const gone = await waitUp(1500);
check(gone < 0, '服务已停干净');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
