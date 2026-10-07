#!/usr/bin/env node
/**
 * 任务层回归（票 014）：状态机 / items 快照 / 事件流 / 取消 / 撤销 / 重启收敛。
 *
 *   node tools/e2e-jobs.mjs
 *
 * 自己造一棵假库（`tools/make-fixture.mjs`）、起一个**独立端口 + 独立数据目录**的实例
 * （不动 dev.sh 那个），跑完把进程组收掉。任务是「批注」这个 kind 的容器，但这里只考任务层本身：
 * 回流细节在 `tools/e2e-annotate.mjs`。
 *
 * 断言：
 *   ① `mode: 'plan'` 只预演：返回 id 固定 `"plan"`、**不落库**（`jobs.jsonl` 都不创建）；
 *   ② `mode: 'apply'` 落库入队，handler 跑完后 `running` + artifacts + 事件 created/dispatched/note；
 *   ③ `items` 是创建那一刻的快照：把照片移进回收站，任务里的 items 与 progress.total 都不动；
 *   ④ 事件流：`seq` 严格递增、`?since=` 只取增量、`nextSince` 当游标（空增量时等于 since）；
 *   ⑤ 非法迁移 409（已收摊的任务再取消 / 重复撤销）；未注册 kind、缺参数 → 400 带可用清单；
 *   ⑥ `undo`：按本任务写下的 `from` 把标注回滚，任务落 `cancelled` + `undone` 事件；
 *   ⑦ 重启：`running` 收敛成 `interrupted`（并留一条 note），其余任务按 JSONL 重放还原，
 *      被收敛的任务还能 `cancel`；
 *   ⑧ 没有凭据一律 401（任务层不因为「是本机的」就开门）；
 *   ⑨ `selection.project` 真会按根过滤（不存在的根 → 展开为空 → 400，不会静默展开全库）；
 *   ⑩ 崩溃写残的日志尾行：下次启动截掉，不会粘坏下一条追加。
 *
 * 环境变量：JOBS_TEST_PORT（默认 8789）、JOBS_TEST_ROOT（默认 /tmp/artworks-jobs-fixture）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');
const PORT = Number(process.env.JOBS_TEST_PORT ?? 8789);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const FIXTURE = process.env.JOBS_TEST_ROOT ?? '/tmp/artworks-jobs-fixture';
const DATA_DIR = '/tmp/artworks-jobs-data';
const CFG = '/tmp/artworks-jobs-test.yaml';
const LOG = '/tmp/artworks-jobs-server.log';
const PASSWORD = 'e2e-jobs-pw';

let pass = 0;
let fail = 0;
let cookie = '';

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

async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
  return { status: res.status, body };
}

const post = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

async function pollJob(id, want, ms = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const { body } = await req(`/jobs/${id}`);
    last = body;
    if (body && want.includes(body.state)) return body;
    await sleep(60);
  }
  return last;
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
  if ((await waitDown(4000)) >= 0) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* 已经没了 */
    }
    await waitDown(3000);
  }
}

/** 端口不响应了返回耗时，仍然活着返回 -1 */
async function waitDown(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
      if (!res.ok) return Date.now() - t0;
    } catch {
      return Date.now() - t0;
    }
    await sleep(100);
  }
  return -1;
}

/**
 * 收掉上次跑崩时残留的实例：脚本上一轮被异常打断时，detached 的服务会留着、把端口占住，
 * 于是这一轮新起的进程静默 EADDRINUSE 退出，测试就会「对着旧进程跑」——那才叫真正的假绿。
 * 按 env 里的 `ARTWORKS_CONFIG` 认人（本脚本专用的配置路径），不会误伤 dev.sh 那个。
 */
function reapLeftover() {
  let killed = 0;
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let env = '';
    try {
      env = readFileSync(`/proc/${name}/environ`, 'utf8');
    } catch {
      continue;
    }
    if (!env.includes(`ARTWORKS_CONFIG=${CFG}`)) continue;
    try {
      process.kill(Number(name), 'SIGKILL');
      killed++;
    } catch {
      /* 刚好自己退了 */
    }
  }
  return killed;
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

/** 一排照片的 DTO（`/photos?dir=`）：任务层的 items 就该跟它一致 */
async function photosIn(dir) {
  const { body } = await req(`/photos?dir=${encodeURIComponent(dir)}&limit=100`);
  return body?.items ?? [];
}

/** 等后台扫描把这个目录扫出来（起服务只是起来了，扫盘是后头跑的） */
async function waitPhotos(dir, want, ms = 30_000) {
  const t0 = Date.now();
  let items = [];
  while (Date.now() - t0 < ms) {
    items = await photosIn(dir);
    if (items.length >= want) break;
    await sleep(200);
  }
  return items;
}

console.log(`\n=== 任务层回归（票 014）：${BASE} ===\n`);
console.log(`  假库 ${FIXTURE}\n  独立数据目录 ${DATA_DIR}\n`);

// ── 准备：一棵干净的假库 + 一个干净的实例 ──────────────────────────────────
// 上一轮被异常打断时 detached 的服务会留着：先收干净。否则这一轮新起的进程会静默
// EADDRINUSE 退出，测试就变成「对着旧进程跑」（数据目录都被删了它还在）——这种假绿最坑人。
const reaped = reapLeftover();
if (reaped) {
  console.log(`  收掉上次残留的服务进程 ${reaped} 个`);
  await waitDown(4000);
}
check((await waitDown(300)) >= 0, '起服务前端口是空的（没有旧实例占着）');

console.log('  造库…');
const mk = spawnSync('node', ['tools/make-fixture.mjs', FIXTURE], { cwd: SERVER_DIR, stdio: 'ignore' });
if (mk.status !== 0 || !existsSync(FIXTURE)) {
  console.error(`假库造不出来（exit ${mk.status}）：${FIXTURE}`);
  process.exit(2);
}
const A7 = '/test/2026-冰岛/A7M4';
const FUJI = '/test/2026-冰岛/Fuji X-T5';

rmSync(DATA_DIR, { recursive: true, force: true });
rmSync(LOG, { force: true });
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(
  CFG,
  [
    'host: 127.0.0.1',
    `port: ${PORT}`,
    `dataDir: ${DATA_DIR}`,
    `password: "${PASSWORD}"`,
    'logLevel: info',
    'roots:',
    '  - id: test',
    '    label: 本机测试库',
    `    path: ${FIXTURE}`,
    'scan:',
    '  maxDepth: 8',
    '',
  ].join('\n'),
  'utf8',
);

let server = startServer();
const upMs = await waitUp();
if (upMs < 0 || server.exitCode !== null) {
  console.error(`服务起不来（exit ${server.exitCode}），看日志 ${LOG}`);
  await stopServer(server);
  process.exit(2);
}
console.log(`  服务起来了（${upMs}ms）\n`);

const login = await post('/session', { password: PASSWORD });
check(login.status === 204, '登录成功（后面的调用都带会话 cookie）', `status=${login.status}`);

// ── 0. 鉴权与能力自描述 ────────────────────────────────────────────────────
console.log('\n── 任务层开门与能力自描述 ──');
const savedCookie = cookie;
cookie = '';
const noAuth = await req('/jobs');
check(noAuth.status === 401, '没凭据访问 /jobs → 401', `status=${noAuth.status}`);
const noAuthInbound = await post('/jobs/whatever/inbound', { items: [{ photoId: 'x', stars: 1 }] });
check(noAuthInbound.status === 401, '没凭据访问 /jobs/{id}/inbound → 401', `status=${noAuthInbound.status}`);
cookie = savedCookie;

const caps = await req('/capabilities');
const capJobs = caps.body?.jobs ?? [];
const annotate = capJobs.find((j) => j.kind === 'annotate');
check(Boolean(annotate), '/capabilities 的 jobs 列出 annotate', capJobs.map((j) => j.kind).join(','));
check(annotate?.undoable === true && annotate?.sideEffect === 'mark', 'annotate 自描述 sideEffect/undoable', `${annotate?.sideEffect}/${annotate?.undoable}`);
check(Boolean(annotate?.params?.label), 'annotate 自描述 params.label', JSON.stringify(annotate?.params?.label ?? null));
const channels = await req('/channels');
check(channels.body?.items?.some((c) => c.id === 'inapp' && c.enabled === true), 'GET /channels 有内置 inapp 通道', JSON.stringify(channels.body?.items ?? null));

const a7Photos = await waitPhotos(A7, 5);
const fujiPhotos = await waitPhotos(FUJI, 1);
const total = a7Photos.length;
check(total === 5, 'A7M4 目录 5 张（3 对双出 + 1 单 RAW + 1 带 xmp）', `n=${total}`);
check(fujiPhotos.length === 1, 'Fuji 目录 1 张（任务外的对照）', `n=${fujiPhotos.length}`);
const listAll = await req('/jobs');
check(Array.isArray(listAll.body?.items) && listAll.body.items.length === 0, '新数据目录里没有任何任务', JSON.stringify(listAll.body));

// ── 1. plan：只预演，不落库 ────────────────────────────────────────────────
console.log('\n── mode=plan：预演不落库 ──');
const planRes = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆', channel: 'inapp' } });
const plan = planRes.body;
check(planRes.status === 201, 'plan → 201', `status=${planRes.status}`);
check(plan?.id === 'plan' && plan?.state === 'planned', 'plan 返回的是预览（id 固定 "plan"）', `${plan?.id}/${plan?.state}`);
check(plan?.items?.length === total, 'plan 把选择集展开成 items 快照', `n=${plan?.items?.length}`);
check((plan?.items ?? []).every((i) => i.status === 'planned' && i.id && i.displayName), 'plan 的 items 都是 planned 且带 displayName', JSON.stringify(plan?.items?.[0] ?? null));
check(plan?.progress?.done === 0 && plan?.progress?.total === total, 'plan 的 progress', JSON.stringify(plan?.progress));
check((plan?.artifacts ?? []).length === 0, 'plan 不签发任何东西（没有 artifacts）', JSON.stringify(plan?.artifacts));
const afterPlan = await req('/jobs');
check((afterPlan.body?.items ?? []).length === 0, 'plan 之后 GET /jobs 还是空的（不落库）', `n=${afterPlan.body?.items?.length}`);
const planFetch = await req('/jobs/plan');
check(planFetch.status === 404, 'plan 的预览不是真任务：GET /jobs/plan → 404', `status=${planFetch.status}`);
check(!existsSync(join(DATA_DIR, 'jobs.jsonl')), 'plan 连 jobs.jsonl 都不创建（磁盘上没有痕迹）');

// ── 2. apply：落库、入队、handler 跑完进 running ───────────────────────────
console.log('\n── mode=apply：落库 + 派发 ──');
const applyRes = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆', channel: 'inapp' }, mode: 'apply' });
const created = applyRes.body;
check(applyRes.status === 201, 'apply → 201', `status=${applyRes.status}`);
check(['planned', 'queued'].includes(created?.state), '201 返回的状态是 planned/queued（执行在后台）', created?.state);
check(created?.id && created.id !== 'plan', 'apply 拿到真任务 id', created?.id);
const jobId = created?.id;
check(created?.reversible === true && created?.kind === 'annotate', 'reversible 来自 handler.undoable', `${created?.reversible}`);
check(JSON.stringify(created?.selection) === JSON.stringify({ where: { folder: 'A7M4' } }), 'selection 原样留住（凭据）', JSON.stringify(created?.selection));

const afterApply = await req('/jobs');
check((afterApply.body?.items ?? []).some((j) => j.id === jobId), 'apply 之后能在列表里查到（落库了）', `n=${afterApply.body?.items?.length}`);
const running = await pollJob(jobId, ['running', 'done', 'failed']);
check(running?.state === 'running', 'handler 跑完 → running（等外部回流）', running?.state);
check(Boolean(running?.startedAt) && Boolean(running?.dispatchedAt), 'running 记了 startedAt，annotate 记了 dispatchedAt', `${running?.startedAt}/${running?.dispatchedAt}`);
check(running?.artifacts?.[0]?.kind === 'url' && running.artifacts[0].path.startsWith('/j?t='), 'artifacts 里有一条范围链接', JSON.stringify(running?.artifacts ?? null));
check(running?.items?.length === total && running?.progress?.total === total, `items 快照 ${total} 项（与 plan 一致）`, `n=${running?.items?.length}`);
const byState = await req('/jobs?state=running&limit=10');
check((byState.body?.items ?? []).every((j) => j.state === 'running') && (byState.body?.items ?? []).some((j) => j.id === jobId), 'GET /jobs?state=running 过滤生效', `n=${byState.body?.items?.length}`);
const byBadLimit = await req('/jobs?limit=abc');
check((byBadLimit.body?.items ?? []).length === (afterApply.body?.items ?? []).length, 'limit 不是数字时退回默认（不是静默返回 0 条）', `n=${byBadLimit.body?.items?.length}`);

// ── 3. 事件流：seq 单调 + since 增量 ───────────────────────────────────────
console.log('\n── 事件日志（seq / since / nextSince）──');
const ev1 = await req(`/jobs/${jobId}/events`);
const seqs = (ev1.body?.items ?? []).map((e) => e.seq);
check(ev1.body?.items?.[0]?.type === 'created', '第一条事件是 created', ev1.body?.items?.[0]?.type);
check(ev1.body?.items?.[1]?.type === 'dispatched', '第二条是 dispatched', ev1.body?.items?.[1]?.type);
check(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq 严格递增', seqs.join(','));
check(ev1.body?.nextSince === seqs[seqs.length - 1], 'nextSince = 最后一条 seq', `${ev1.body?.nextSince}`);
const evTail = await req(`/jobs/${jobId}/events?since=${ev1.body.nextSince}`);
check((evTail.body?.items ?? []).length === 0 && evTail.body?.nextSince === ev1.body.nextSince, 'since=nextSince 时没有新事件，游标不动', JSON.stringify(evTail.body));
const evFrom1 = await req(`/jobs/${jobId}/events?since=${seqs[0]}`);
check((evFrom1.body?.items ?? []).every((e) => e.seq > seqs[0]), 'since 只取之后的事件', (evFrom1.body?.items ?? []).map((e) => e.seq).join(','));
const evLimit1 = await req(`/jobs/${jobId}/events?limit=1`);
check((evLimit1.body?.items ?? []).length === 1, 'events?limit 生效', `n=${evLimit1.body?.items?.length}`);

// ── 4. items 快照稳定：把一张照片移进回收站 ─────────────────────────────────
console.log('\n── items 快照稳定（照片被移走也不动）──');
const snapTotal = running?.progress?.total ?? -1;
const target = a7Photos.find((p) => p.displayName === '_DSC0005') ?? a7Photos[0];
const trashed = await post('/trash', { ids: [target.id] });
check(trashed.status === 200 && trashed.body?.ok !== false, '把 _DSC0005 移进回收站', `status=${trashed.status} ${JSON.stringify(trashed.body).slice(0, 100)}`);
const a7AfterTrash = await photosIn(A7);
check(a7AfterTrash.length === a7Photos.length - 1, '照片确实从列表里消失了（少一张）', `${a7Photos.length} → ${a7AfterTrash.length}`);
const stillThere = await req(`/jobs/${jobId}`);
check((stillThere.body?.items ?? []).some((i) => i.id === target.id), '任务里那张照片还在 items 里（快照不动）', `n=${stillThere.body?.items?.length}`);
check(stillThere.body?.progress?.total === snapTotal, 'progress.total 也不变（快照的分母）', `${snapTotal} → ${stillThere.body?.progress?.total}`);

// ── 5. undo：按本任务写下的 from 回滚 ──────────────────────────────────────
console.log('\n── inbound + undo：写下的能从 from 回滚 ──');
// 用还在库里的两张（上面刚搬走一张，搬走的写不进去了）
const pick = a7Photos.filter((p) => p.hasJpeg && p.id !== target.id).slice(0, 2);
const before = pick.map((p) => ({ id: p.id, stars: p.stars ?? 0, del: p.del === true }));
const inb = await post(`/jobs/${jobId}/inbound`, { items: pick.map((p, n) => ({ photoId: p.id, stars: n === 0 ? 3 : 0, del: n === 1, clientRef: `jobs-${n}` })) });
check(inb.status === 200 && (inb.body?.results ?? []).length === 2 && inb.body.results.every((r) => r.ok), '主凭据也能往任务里写（by=me）', JSON.stringify(inb.body?.results ?? null).slice(0, 120));
const afterInb = await req(`/jobs/${jobId}`);
check(afterInb.body?.progress?.done === 2, 'progress.done 随 items 终态推进', JSON.stringify(afterInb.body?.progress));
const histJ = await req(`/marks/history?jobId=${jobId}`);
check((histJ.body?.items ?? []).length >= 2 && (histJ.body?.items ?? []).every((c) => c.jobId === jobId), 'marks/history?jobId= 只回本任务的变更', `n=${histJ.body?.items?.length}`);
const undoRes = await post(`/jobs/${jobId}/undo`);
check(undoRes.status === 200 && undoRes.body?.state === 'cancelled', 'undo → 任务落 cancelled', `${undoRes.status}/${undoRes.body?.state}`);
const afterUndo = await photosIn(A7);
const restored = pick.every((p) => {
  const now = afterUndo.find((x) => x.id === p.id);
  const was = before.find((b) => b.id === p.id);
  return now && (now.stars ?? 0) === was.stars && (now.del === true) === was.del;
});
check(restored, '标注回到任务前的样子', pick.map((p) => `${p.displayName}:${p.stars}/${p.del}`).join(' '));
const evUndo = await req(`/jobs/${jobId}/events?since=${ev1.body.nextSince}`);
const undoneEvents = (evUndo.body?.items ?? []).filter((e) => e.type === 'undone');
check(undoneEvents.length >= 2, '事件流里有 undone（含一条总结）', undoneEvents.map((e) => e.seq).join(','));
const undoAgain = await post(`/jobs/${jobId}/undo`);
check(undoAgain.status === 409, '重复 undo → 409（撤销过了）', `${undoAgain.status} ${JSON.stringify(undoAgain.body?.error ?? '')}`);
const cancelDone = await post(`/jobs/${jobId}/cancel`);
check(cancelDone.status === 409, '已撤销（cancelled）的任务再取消 → 409（非法迁移）', `${cancelDone.status} ${JSON.stringify(cancelDone.body?.error ?? '')}`);

// ── 6. 400 家族：未注册 kind / 参数缺失 / 空选择集 / 坏 mode ────────────────
console.log('\n── 参数校验（400 带可用清单）──');
const badKind = await post('/jobs', { kind: 'export', selection: {}, mode: 'plan' });
check(badKind.status === 400 && String(badKind.body?.error ?? '').includes('annotate'), '未注册 kind → 400 并列出可用 kind', `${badKind.status} ${JSON.stringify(badKind.body?.error ?? '')}`);
const noLabel = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, mode: 'plan' });
const problems = noLabel.body?.detail?.problems ?? [];
check(noLabel.status === 400 && problems.some((p) => p.field === 'params.label'), '缺 params.label → 400 + problems', JSON.stringify(problems).slice(0, 140));
const badChannel = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆', channel: 'feishu' }, mode: 'plan' });
check(badChannel.status === 400 && (badChannel.body?.detail?.problems ?? []).some((p) => p.field === 'params.channel'), '没配的通道 → 400', JSON.stringify(badChannel.body?.detail?.problems ?? null).slice(0, 140));
const emptySel = await post('/jobs', { kind: 'annotate', selection: { where: { folder: '这个目录不存在' } }, params: { label: '老婆' }, mode: 'plan' });
check(emptySel.status === 400 && (emptySel.body?.detail?.problems ?? []).some((p) => p.field === 'selection'), '选择集里一张照片都没有 → 400', `${emptySel.status} ${JSON.stringify(emptySel.body?.detail?.problems ?? null).slice(0, 120)}`);
const badMode = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆' }, mode: 'wat' });
check(badMode.status === 400, 'mode 不是 plan/apply → 400', `${badMode.status} ${JSON.stringify(badMode.body?.error ?? '')}`);

// ── 7. cancel 一个正在等的任务 + 重启收敛 ─────────────────────────────────
console.log('\n── cancel + 重启收敛（interrupted）──');
const second = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆' }, mode: 'apply' });
const secondId = second.body?.id;
await pollJob(secondId, ['running']);
const secondCancel = await post(`/jobs/${secondId}/cancel`);
check(secondCancel.status === 200 && secondCancel.body?.state === 'cancelled', 'cancel 正在等回流的任务 → cancelled', `${secondCancel.status}/${secondCancel.body?.state}`);
check(Boolean(secondCancel.body?.finishedAt), 'cancelled 记了 finishedAt', String(secondCancel.body?.finishedAt));
const secondEvents = await req(`/jobs/${secondId}/events`);
check((secondEvents.body?.items ?? []).some((e) => e.type === 'cancelled'), '事件流里记了 cancelled', (secondEvents.body?.items ?? []).map((e) => e.type).join(','));

const third = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'Fuji X-T5' } }, params: { label: '老婆' }, mode: 'apply' });
const thirdId = third.body?.id;
const thirdRunning = await pollJob(thirdId, ['running']);
check(thirdRunning?.state === 'running', '第三个任务跑起来了（重启前拦住它）', thirdRunning?.state);
const thirdItems = (thirdRunning?.items ?? []).length;

await stopServer(server);
const downMs = await waitDown();
check(downMs >= 0, '服务真的停了（端口没人应答）', `${downMs}ms`);
server = startServer();
const up3 = await waitUp();
check(up3 >= 0 && server.exitCode === null, '同一个数据目录上再拉起来（新进程，不是旧进程）', `${up3}ms`);
await post('/session', { password: PASSWORD });

const reopened = await req(`/jobs/${thirdId}`);
check(reopened.body?.state === 'interrupted', '重启后 running 收敛成 interrupted', reopened.body?.state);
check(Boolean(reopened.body?.error) === false, 'interrupted 不改 items', `n=${reopened.body?.items?.length}`);
check((reopened.body?.items ?? []).length === thirdItems, '重放还原了 items 快照', `${thirdItems} → ${reopened.body?.items?.length}`);
const interEvents = await req(`/jobs/${thirdId}/events`);
check((interEvents.body?.items ?? []).some((e) => e.type === 'note' && String(e.note ?? '').includes('interrupted')), '收敛时留了一条 note 说明（不是静默改状态）', JSON.stringify((interEvents.body?.items ?? []).slice(-1)[0]?.note ?? ''));
const interList = await req('/jobs?state=interrupted');
check((interList.body?.items ?? []).some((j) => j.id === thirdId), 'GET /jobs?state=interrupted 能查到', `n=${interList.body?.items?.length}`);
const replayed = await req(`/jobs/${jobId}`);
check(replayed.body?.state === 'cancelled' && (replayed.body?.items ?? []).some((i) => i.status === 'done'), '重启重放还原了别的任务（含 items 终态）', `${replayed.body?.state} ${JSON.stringify(replayed.body?.progress)}`);
const replayedEvents = await req(`/jobs/${jobId}/events`);
check((replayedEvents.body?.items ?? []).length === (ev1.body?.items ?? []).length + (evUndo.body?.items ?? []).length, '事件日志重放后条数一致（seq 不重排）', `${replayedEvents.body?.items?.length}`);
const cancelInterrupted = await post(`/jobs/${thirdId}/cancel`);
check(cancelInterrupted.status === 200 && cancelInterrupted.body?.state === 'cancelled', '被收敛的任务还能 cancel（收摊）', `${cancelInterrupted.status}/${cancelInterrupted.body?.state}`);

// ── 8. 磁盘上的形状：JSONL 追加日志 ───────────────────────────────────────
console.log('\n── jobs.jsonl / job-events.jsonl ──');
const jobLines = readFileSync(join(DATA_DIR, 'jobs.jsonl'), 'utf8').trim().split('\n');
const evLines = readFileSync(join(DATA_DIR, 'job-events.jsonl'), 'utf8').trim().split('\n');
check(jobLines.every((l) => JSON.parse(l).t === 'job'), 'jobs.jsonl 每行一个 {t:"job"} 快照', `n=${jobLines.length}`);
check(evLines.every((l) => JSON.parse(l).t === 'event'), 'job-events.jsonl 每行一个 {t:"event"}', `n=${evLines.length}`);
const seqOnDisk = evLines.map((l) => JSON.parse(l).seq);
check(seqOnDisk.every((s, i) => i === 0 || s > seqOnDisk[i - 1]), '磁盘上的 seq 也严格递增', seqOnDisk.join(','));
const finalJob = JSON.parse(jobLines.filter((l) => JSON.parse(l).id === jobId).slice(-1)[0]);
check(finalJob.state === 'cancelled', '同一任务的多行快照里最后一行是终态（后写覆盖先写）', finalJob.state);

// ── 9. selection.project 真会按根过滤 ────────────────────────────────────
console.log('\n── selection.project 过滤 ──');
const projOk = await post('/jobs', { kind: 'annotate', selection: { project: 'test', where: { folder: 'A7M4' } }, params: { label: '老婆' }, mode: 'plan' });
check(projOk.status === 201 && projOk.body?.id === 'plan' && (projOk.body?.items ?? []).length > 0, 'project 命中本根 → 正常展开', `${projOk.status} n=${(projOk.body?.items ?? []).length}`);
const projBad = await post('/jobs', { kind: 'annotate', selection: { project: 'no-such-root', where: { folder: 'A7M4' } }, params: { label: '老婆' }, mode: 'plan' });
check(projBad.status === 400 && (projBad.body?.detail?.problems ?? []).some((p) => p.field === 'selection'), 'project 指到不存在的根 → 展开为空 → 400（不再静默展开全库）', `${projBad.status} ${JSON.stringify(projBad.body?.detail?.problems ?? null).slice(0, 120)}`);

// ── 10. 崩溃写残的尾行：下次启动修好，不粘坏下一行 ────────────────────────
console.log('\n── 日志尾行被写残（崩溃残留）──');
await stopServer(server);
await waitDown();
const jobsFile = join(DATA_DIR, 'jobs.jsonl');
appendFileSync(jobsFile, '{"t":"job","id":"trunc');
server = startServer();
const up4 = await waitUp();
check(up4 >= 0 && server.exitCode === null, '带着残行重新起来', `${up4}ms`);
await post('/session', { password: PASSWORD });
const repairedText = readFileSync(jobsFile, 'utf8');
check(repairedText.endsWith('\n'), '启动时把残行截掉了（文件以换行收尾）', `${repairedText.length} 字节`);
check(repairedText.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), '修完之后每行都是合法 JSON', `${repairedText.trim().split('\n').length} 行`);
const afterRepair = await post('/jobs', { kind: 'annotate', selection: { where: { folder: 'A7M4' } }, params: { label: '老婆' }, mode: 'plan' });
check(afterRepair.status === 201 && afterRepair.body?.id === 'plan', '修完之后还能正常预演（服务没被残行带崩）', `status=${afterRepair.status}`);
const listed = await req('/jobs');
check((listed.body?.items ?? []).length >= 2, '重放还是能列出之前的任务', `n=${(listed.body?.items ?? []).length}`);

await stopServer(server);

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
console.log(`（服务日志：${LOG}）\n`);
process.exit(fail ? 1 : 0);
