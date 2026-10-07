#!/usr/bin/env node
/**
 * 批注往返回归（票 015）：范围 token + 回流 + 幂等 + 撤销 + 失效。
 *
 *   node tools/e2e-annotate.mjs
 *
 * 自己造一棵假库、起一个**独立端口 + 独立数据目录**的实例（跟 dev.sh 那个没关系），
 * 走一遍真实链路：本机建 annotate 任务 → 拿到 `/j?t=<范围 token>` → 用这个 token（不带任何主凭据）
 * 读本任务的缩略图、写回流 → 主凭据对账 → undo 回滚 → 撤销后 token 作废。
 *
 * 断言：
 *   ① token 载荷是 `annotate|<jobId>|<别名>|<exp>`，有效期 30 天；
 *   ② 范围 token 只能读**本任务 items 里**的缩略图（任务外 404），只能 POST 本任务的 inbound；
 *      拿它去 GET /jobs、/photos、/marks/history 一律 401（范围受限不是嘴上说说）；
 *   ③ 回流里的 `by` 由 token 推（`link:<别名>`），请求体里塞的 `by` 被忽略；
 *   ④ `clientRef` 幂等：重发同样的项不重复写盘、返回首次结果、事件留 `skipped`；改值也一样被挡住；
 *   ⑤ items 全有终态 → 任务 `done`；`GET /marks/history?jobId=` 能对账（from → to、channel、by）；
 *   ⑥ undo 按本任务写下的 `from` 回滚（记 `channel: 'undo'`），任务落 `cancelled` + `undone` 事件；
 *   ⑦ 任务取消 / 撤销后范围 token 立刻失效（403）；伪造/篡改 token 401；
 *   ⑧ 范围 token 绑在**签发它的 API token** 上（载荷第 5 段）：撤销那条 token，链接立刻失效；
 *      缩略图 linkToken 是只读凭据，拿去写回流一律 401；
 *   ⑨ 并发重发同一个 `clientRef` 也只写一次（幂等抗竞态）。
 *
 * 环境变量：ANNOTATE_TEST_PORT（默认 8790）、ANNOTATE_TEST_ROOT（默认 /tmp/artworks-annotate-fixture）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..');
const PORT = Number(process.env.ANNOTATE_TEST_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const FIXTURE = process.env.ANNOTATE_TEST_ROOT ?? '/tmp/artworks-annotate-fixture';
const DATA_DIR = '/tmp/artworks-annotate-data';
const CFG = '/tmp/artworks-annotate-test.yaml';
const LOG = '/tmp/artworks-annotate-server.log';
const PASSWORD = 'e2e-annotate-pw';
const DAY_MS = 24 * 3600 * 1000;

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

/** 带会话 cookie 的请求（主凭据：本机自己） */
async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
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

/** 不带任何会话 cookie 的请求（批注者手里只有链接） */
async function bare(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: text.length, body };
}

const post = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/** 带 Bearer（API token）的请求：模拟 agent 用主凭据建任务（范围 token 要绑在它上面） */
async function bearerReq(path, token, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

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

/** 收掉上次跑崩残留的实例（按本脚本专用的 ARTWORKS_CONFIG 认人，绝不误伤 dev.sh 那个） */
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

async function photosIn(dir) {
  const { body } = await req(`/photos?dir=${encodeURIComponent(dir)}&limit=100`);
  return body?.items ?? [];
}

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

/** 从 artifact 的 `/j?t=<token>` 里取 token，顺便解出载荷（载荷不是 JSON，是 `kind|jobId|别名|exp`） */
function payloadOf(token) {
  const [kind, jobId, alias, exp, tokenId] = Buffer.from(token.split('.')[0], 'base64url').toString('utf8').split('|');
  return { kind, jobId, alias, exp: Number(exp), tokenId };
}

console.log(`\n=== 批注往返回归（票 015）：${BASE} ===\n`);
console.log(`  假库 ${FIXTURE}\n  独立数据目录 ${DATA_DIR}\n`);

// ── 准备 ──────────────────────────────────────────────────────────────────
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

const server = startServer();
const upMs = await waitUp();
if (upMs < 0 || server.exitCode !== null) {
  console.error(`服务起不来（exit ${server.exitCode}），看日志 ${LOG}`);
  await stopServer(server);
  process.exit(2);
}
console.log(`  服务起来了（${upMs}ms）\n`);

const login = await post('/session', { password: PASSWORD });
check(login.status === 204, '登录（主凭据 = 本机自己）', `status=${login.status}`);
const a7Photos = await waitPhotos(A7, 5);
const fujiPhotos = await waitPhotos(FUJI, 1);
check(a7Photos.length === 5 && fujiPhotos.length === 1, '假库扫出来了', `A7M4=${a7Photos.length} Fuji=${fujiPhotos.length}`);

// ── 1. 建任务拿范围链接 ───────────────────────────────────────────────────
console.log('\n── 建 annotate 任务：签一张范围 token ──');
const picks = a7Photos.filter((p) => p.displayName !== '_DSC0005').slice(0, 3); // 三张 JPG+RAW 双出
const outsider = fujiPhotos[0];
const before = picks.map((p) => ({ id: p.id, stars: p.stars ?? 0, del: p.del === true }));
const created = (
  await post('/jobs', {
    kind: 'annotate',
    selection: { ids: picks.map((p) => p.id) },
    params: { channel: 'inapp', label: '老婆' },
    mode: 'apply',
  })
).body;
check(Boolean(created?.id) && created.id !== 'plan', 'apply 建任务 → 201 带真 id', created?.id);
const jobId = created?.id;
const job = await pollJob(jobId, ['running', 'done', 'failed']);
check(job?.state === 'running', '任务在等回流（running）', job?.state);
check(job?.items?.length === 3 && job?.progress?.total === 3, 'items 就是选择集里那 3 张', `n=${job?.items?.length}`);
check(job?.params?.label === '老婆' && job?.channel === 'inapp', 'params/channel 留住（别名要用来记 by）', `${job?.params?.label}/${job?.channel}`);

const linkPath = job?.artifacts?.find((a) => a.kind === 'url')?.path ?? '';
const token = linkPath.startsWith('/j?t=') ? linkPath.slice(5) : '';
check(linkPath.startsWith('/j?t=') && token.split('.').length === 2, 'artifacts 里有批注链接（/j?t=<token>）', linkPath.slice(0, 24) + '…');
const p = payloadOf(token);
check(p.kind === 'annotate' && p.jobId === jobId && p.alias === '老婆', 'token 载荷是 annotate|<jobId>|<别名>|<exp>', `annotate|${p.jobId?.slice(0, 6)}…|${p.alias}|${p.exp}`);
check(Math.abs(p.exp - Date.now() - 30 * DAY_MS) < DAY_MS, '有效期 30 天', `${Math.round((p.exp - Date.now()) / DAY_MS)} 天`);

// ── 2. 范围 token 的门：只能看本任务的照片，只能写本任务的回流 ─────────────
console.log('\n── 范围 token 能干什么、不能干什么 ──');
const noAuthThumb = await bare(`/photos/${picks[0].id}/thumb`);
check(noAuthThumb.status === 401, '没带凭据读缩略图 → 401', `status=${noAuthThumb.status}`);

let inScopeOk = 0;
for (const pic of picks) {
  const r = await bare(`/photos/${pic.id}/thumb?t=${encodeURIComponent(token)}`);
  if (r.status === 200 && r.type.startsWith('image/') && r.bytes > 0) inScopeOk++;
  else console.log(`  （任务内 ${pic.displayName} 缩略图 ${r.status} ${r.type}）`);
}
check(inScopeOk === 3, '范围 token 能读本任务 3 张的缩略图（200 + 图片）', `${inScopeOk}/3`);

const outThumb = await bare(`/photos/${outsider.id}/thumb?t=${encodeURIComponent(token)}`);
check(outThumb.status === 404, '任务外的照片 → 404（不是「看不到但存在」）', `status=${outThumb.status} ${outsider.displayName}`);
const outThumb2 = await bare(`/photos/${a7Photos.find((x) => x.displayName === '_DSC0005').id}/thumb?t=${encodeURIComponent(token)}`);
check(outThumb2.status === 404, '同一个目录但不在 items 里 → 404', `status=${outThumb2.status} _DSC0005`);

const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
const badToken = await bare(`/photos/${picks[0].id}/thumb?t=${encodeURIComponent(tampered)}`);
check(badToken.status === 401, '篡改过的 token → 401（链上签名不是摆设）', `status=${badToken.status}`);
const junk = await bare(`/photos/${picks[0].id}/thumb?t=这不是token`);
check(junk.status === 401, '乱给的 token → 401', `status=${junk.status}`);

const tokenJobs = await bare(`/jobs?t=${encodeURIComponent(token)}`);
check(tokenJobs.status === 401, '范围 token 读任务列表 → 401（范围外的事一件也干不了）', `status=${tokenJobs.status}`);
const tokenPhotos = await bare(`/photos?dir=${encodeURIComponent(A7)}&t=${encodeURIComponent(token)}`);
check(tokenPhotos.status === 401, '范围 token 读照片列表 → 401', `status=${tokenPhotos.status}`);
const tokenHistory = await bare(`/marks/history?jobId=${jobId}&t=${encodeURIComponent(token)}`);
check(tokenHistory.status === 401, '范围 token 读标注历史 → 401', `status=${tokenHistory.status}`);
const otherInbound = await bare(`/jobs/不存在的任务/inbound?t=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ items: [{ photoId: picks[0].id, stars: 5 }] }) });
check([403, 404].includes(otherInbound.status), '拿这个 token 去写别人的任务 → 403/404', `status=${otherInbound.status}`);

// ── 3. 回流：by 由 token 推，写进 marks.jsonl，主凭据能对账 ────────────────
console.log('\n── 回流（?t=，免登录）──');
const items = [
  { photoId: picks[0].id, stars: 4, clientRef: 'batch-1' },
  { photoId: picks[1].id, stars: 2, del: false, clientRef: 'batch-2' },
  { photoId: picks[2].id, del: true, clientRef: 'batch-3', by: '伪造的' }, // by 必须被忽略
];
const inb = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ items }) });
check(inb.status === 200, 'POST /jobs/{id}/inbound?t= → 200', `status=${inb.status} ${JSON.stringify(inb.body).slice(0, 80)}`);
const results = inb.body?.results ?? [];
check(results.length === 3 && results.every((r) => r.ok), '三项都写成功', JSON.stringify(results.map((r) => `${r.stars ?? '-'}/${r.del ?? '-'}`)).slice(0, 90));

const afterInb = await req(`/jobs/${jobId}`);
check(afterInb.body?.progress?.done === 3 && afterInb.body?.progress?.total === 3, 'progress 推进到 3/3', JSON.stringify(afterInb.body?.progress));
check(afterInb.body?.state === 'done', 'items 全有终态 → 任务 done', afterInb.body?.state);
check(afterInb.body?.finishedAt, 'done 记了 finishedAt', String(afterInb.body?.finishedAt));
const itemOf = (id) => (afterInb.body?.items ?? []).find((i) => i.id === id);
check(itemOf(picks[0].id)?.status === 'done' && itemOf(picks[0].id)?.clientRef === 'batch-1', 'items 里记了终态与 clientRef', JSON.stringify(itemOf(picks[0].id) ?? null).slice(0, 110));
check(String(itemOf(picks[0].id)?.from ?? '').includes('stars:') && String(itemOf(picks[0].id)?.to ?? '').includes('stars:'), 'items 里记了 from → to（对账用）', `${itemOf(picks[0].id)?.from} → ${itemOf(picks[0].id)?.to}`);

const hist = await req(`/marks/history?jobId=${jobId}&limit=100`);
const rows = hist.body?.items ?? [];
check(rows.length >= 3, '主凭据 GET /marks/history?jobId= 看到这次回流', `n=${rows.length}`);
check(rows.every((c) => c.jobId === jobId), '都挂在本任务上（jobId 贯通到变更日志）', rows.map((c) => c.jobId === jobId).join(','));
check(rows.every((c) => c.by === 'link:老婆'), 'by = link:<别名>（由上链的 token 推）', [...new Set(rows.map((c) => c.by))].join(','));
check(!rows.some((c) => String(c.by).includes('伪造')), '请求体里塞的 by 被忽略（凭据说了算）', [...new Set(rows.map((c) => c.by))].join(','));
check(rows.every((c) => c.channel === 'inapp'), 'channel 来自任务的 params.channel', [...new Set(rows.map((c) => c.channel))].join(','));
check(rows.every((c) => c.from !== c.to), 'from ≠ to（真变了才记）', rows.map((c) => `${c.from}→${c.to}`).slice(0, 3).join(' '));
const liveRows = await photosIn(A7);
// 被标了 del 的照片按设计不出现在默认列表里，得用 del 筛选才看得到
const delRows = (await req(`/photos?dir=${encodeURIComponent(A7)}&sel=del:true&limit=100`)).body?.items ?? [];
const seen = (id) => liveRows.find((x) => x.id === id) ?? delRows.find((x) => x.id === id);
const lived =
  (seen(picks[0].id)?.stars ?? -1) === 4 &&
  (seen(picks[1].id)?.stars ?? -1) === 2 &&
  seen(picks[2].id)?.del === true;
check(lived, '照片本身也真的改了（主凭据的列表里能看到）', picks.map((pic) => `${pic.displayName}:${seen(pic.id)?.stars}/${seen(pic.id)?.del}`).join(' '));

const events = await req(`/jobs/${jobId}/events?limit=200`);
const evRows = events.body?.items ?? [];
check(evRows.some((e) => e.type === 'inbound'), '事件流里有 inbound', evRows.map((e) => e.type).join(','));
check(evRows.filter((e) => e.type === 'applied').every((e) => e.by === 'link:老婆' && e.channel === 'inapp'), 'applied 事件带 by/channel', evRows.filter((e) => e.type === 'applied').map((e) => e.by).join(','));
check(evRows.some((e) => e.type === 'done'), '事件流里有 done', evRows.slice(-3).map((e) => e.type).join(','));

// ── 4. clientRef 幂等 ─────────────────────────────────────────────────────
console.log('\n── clientRef 幂等：重发跳过 ──');
const again = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, {
  method: 'POST',
  body: JSON.stringify({ items: [{ photoId: picks[0].id, stars: 1, clientRef: 'batch-1' }, { photoId: picks[1].id, stars: 1, clientRef: 'batch-2' }] }),
});
check(again.status === 200, '重发（同样的 clientRef）→ 200（不是错误）', `status=${again.status}`);
check(again.body?.results?.[0]?.stars === 4, '返回的是**首次**结果（stars 还是 4，不是这次请求的 1）', JSON.stringify(again.body?.results?.[0] ?? null).slice(0, 90));
const histAgain = await req(`/marks/history?jobId=${jobId}&limit=100`);
check((histAgain.body?.items ?? []).length === rows.length, '没有重复写盘（标注日志条数不变）', `${rows.length} → ${histAgain.body?.items?.length}`);
const afterAgain = await req(`/jobs/${jobId}`);
const itemBefore = itemOf(picks[0].id);
const itemAfter = afterAgain.body?.items?.find((i) => i.id === picks[0].id);
check(JSON.stringify(itemBefore) === JSON.stringify(itemAfter), 'items 一个字都没被改写（真的跳过了）', `${JSON.stringify(itemBefore).slice(0, 60)} vs ${JSON.stringify(itemAfter).slice(0, 60)}`);
const evAgain = await bare(`/jobs/${jobId}/events?limit=200&t=${encodeURIComponent(token)}`);
const skipEvents = evAgain.status === 200 ? (evAgain.body?.items ?? []).filter((e) => e.type === 'skipped') : [];
check(again.status === 200 && evAgain.status === 401, '范围 token 也读不了事件（范围外）', `events?t= → ${evAgain.status}`);
const skipViaMain = await req(`/jobs/${jobId}/events?limit=200`);
check((skipViaMain.body?.items ?? []).filter((e) => e.type === 'skipped').length >= 2, '事件流里留了 skipped（跳过了什么有据可查）', `${skipEvents.length} / ${(skipViaMain.body?.items ?? []).filter((e) => e.type === 'skipped').length}`);

const newOnDone = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, {
  method: 'POST',
  body: JSON.stringify({ items: [{ photoId: picks[0].id, stars: 0, clientRef: 'batch-new' }] }),
});
check(newOnDone.status === 409, '已经收摊（done）的任务收新回流 → 409', `${newOnDone.status} ${JSON.stringify(newOnDone.body?.error ?? '')}`);
const outsideId = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, {
  method: 'POST',
  body: JSON.stringify({ items: [{ photoId: outsider.id, clientRef: 'outsider-1' }] }),
});
check(outsideId.status === 404, '写任务外的照片 → 404（token 的选择集就是边界）', `${outsideId.status} ${JSON.stringify(outsideId.body?.error ?? '').slice(0, 60)}`);
const emptyInb = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ items: [] }) });
check(emptyInb.status === 400, 'items 空 → 400', `${emptyInb.status}`);

// ── 5. undo：按本任务写下的 from 回滚 ─────────────────────────────────────
console.log('\n── undo：把这次批注退回去 ──');
const undoRes = await post(`/jobs/${jobId}/undo`);
check(undoRes.status === 200 && undoRes.body?.state === 'cancelled', '主凭据 undo → 任务落 cancelled', `${undoRes.status}/${undoRes.body?.state}`);
const undone = await photosIn(A7);
const backHome = picks.every((pic) => {
  const now = undone.find((x) => x.id === pic.id);
  const was = before.find((b) => b.id === pic.id);
  return now && (now.stars ?? 0) === was.stars && (now.del === true) === was.del;
});
check(backHome, '标注回到任务前的样子', picks.map((pic) => `${pic.displayName}:${undone.find((x) => x.id === pic.id)?.stars}/${undone.find((x) => x.id === pic.id)?.del}`).join(' '));
const undoRows = await req(`/marks/history?jobId=${jobId}&limit=100`);
check((undoRows.body?.items ?? []).some((c) => c.channel === 'undo' && c.by === 'me'), '回滚也记在同一个任务上（channel: undo, by: me）', [...new Set((undoRows.body?.items ?? []).map((c) => `${c.by}/${c.channel}`))].join(','));
const undoEvents = await req(`/jobs/${jobId}/events?limit=200`);
check((undoEvents.body?.items ?? []).some((e) => e.type === 'undone'), '事件流里有 undone', (undoEvents.body?.items ?? []).slice(-4).map((e) => e.type).join(','));

const deadThumb = await bare(`/photos/${picks[0].id}/thumb?t=${encodeURIComponent(token)}`);
check(deadThumb.status === 403, '撤销后 token 读缩略图 → 403（失效了）', `status=${deadThumb.status}`);
const deadInbound = await bare(`/jobs/${jobId}/inbound?t=${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ items: [{ photoId: picks[0].id, stars: 5 }] }) });
check(deadInbound.status === 403, '撤销后 token 写回流 → 403', `status=${deadInbound.status}`);
const noAuthInbound = await bare(`/jobs/${jobId}/inbound`, { method: 'POST', body: JSON.stringify({ items: [{ photoId: picks[0].id, stars: 5 }] }) });
check(noAuthInbound.status === 401, '不带任何凭据写回流 → 401', `status=${noAuthInbound.status}`);

// ── 6. cancel 也会断链 ────────────────────────────────────────────────────
console.log('\n── cancel：链接跟着作废 ──');
const created2 = (await post('/jobs', { kind: 'annotate', selection: { ids: picks.slice(0, 2).map((x) => x.id) }, params: { label: '老王' }, mode: 'apply' })).body;
const job2 = await pollJob(created2?.id, ['running']);
const token2 = (job2?.artifacts?.find((a) => a.kind === 'url')?.path ?? '').slice(5);
check(Boolean(token2) && payloadOf(token2).alias === '老王', '第二个任务（别名 老王）也签了链接', payloadOf(token2).alias);
const aliveThumb = await bare(`/photos/${picks[0].id}/thumb?t=${encodeURIComponent(token2)}`);
check(aliveThumb.status === 200, '取消前链接可用', `status=${aliveThumb.status}`);
const cancelled = await post(`/jobs/${created2.id}/cancel`);
check(cancelled.status === 200 && cancelled.body?.state === 'cancelled', '取消任务', `${cancelled.status}/${cancelled.body?.state}`);
const deadThumb2 = await bare(`/photos/${picks[0].id}/thumb?t=${encodeURIComponent(token2)}`);
check(deadThumb2.status === 403, '取消后链接立刻失效 → 403', `status=${deadThumb2.status}`);
const cancelAgain = await post(`/jobs/${created2.id}/cancel`);
check(cancelAgain.status === 409, '再取消一次 → 409', `${cancelAgain.status}`);
const noUndo = await post(`/jobs/${jobId}/undo`);
check(noUndo.status === 409, '撤销过的任务再 undo → 409', `${noUndo.status} ${JSON.stringify(noUndo.body?.error ?? '')}`);

// ── 7. 主凭据没受影响 ─────────────────────────────────────────────────────
console.log('\n── 主凭据照旧 ──');
const mainJobs = await req('/jobs?limit=10');
check((mainJobs.body?.items ?? []).length === 2, '主凭据能看任务列表', `n=${mainJobs.body?.items?.length}`);
const mainPhotos = await req(`/photos?dir=${encodeURIComponent(A7)}&limit=10`);
check((mainPhotos.body?.items ?? []).length === 5, '主凭据能看照片列表', `n=${mainPhotos.body?.items?.length}`);
const mainThumb = await req(`/photos/${picks[0].id}/thumb`);
check(mainThumb.status === 200, '主凭据读缩略图不受范围 token 影响', `status=${mainThumb.status}`);
const audit = await req(`/marks/history?jobId=${jobId}&limit=200`);
const kinds = (audit.body?.items ?? []).map((c) => `${c.by}/${c.channel}`);
check(new Set(kinds).size >= 2, '一次往返在日志里留下两个来源（批注者 + 自己回滚）', [...new Set(kinds)].join(','));
const jsonl = readFileSync(join(DATA_DIR, 'marks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check(jsonl.some((c) => c.by === 'link:老婆' && c.jobId === jobId), '落盘也在：marks.jsonl 里能看到 link:老婆 + jobId', `${jsonl.length} 行`);

// ── 8. 范围 token 绑在签发它的 API token 上 ───────────────────────────────
console.log('\n── 撤销签发它的 API token，链接立刻作废 ──');
const issued = await post('/api-tokens', { label: 'e2e-agent' });
check(issued.status === 201 && typeof issued.body?.token === 'string', '签发一条 API token（agent 的主凭据）', `status=${issued.status}`);
const agentToken = issued.body?.token ?? '';
const agentLink = issued.body?.linkToken ?? '';
const created3 = await bearerReq('/jobs', agentToken, {
  method: 'POST',
  body: JSON.stringify({ kind: 'annotate', selection: { ids: [picks[1].id] }, params: { label: 'AI 助手' }, mode: 'apply' }),
});
check(created3.status === 201, 'Bearer（API token）建任务 → 201', `status=${created3.status}`);
const job3 = await pollJob(created3.body?.id, ['running']);
const token3 = (job3?.artifacts?.find((a) => a.kind === 'url')?.path ?? '').slice(5);
const p3 = payloadOf(token3);
check(p3.kind === 'annotate' && p3.tokenId === issued.body?.id, '范围 token 里绑着签发它的 token id', `tokenId=${String(p3.tokenId).slice(0, 8)}…`);
const alive3 = await bare(`/photos/${picks[1].id}/thumb?t=${encodeURIComponent(token3)}`);
check(alive3.status === 200, '撤销前范围 token 能读缩略图', `status=${alive3.status}`);
const linkThumb = await bare(`/photos/${picks[1].id}/thumb?t=${encodeURIComponent(agentLink)}`);
check(linkThumb.status === 200, '缩略图 linkToken 照旧能读缩略图', `status=${linkThumb.status}`);
const linkInbound = await bare(`/jobs/${job3?.id}/inbound?t=${encodeURIComponent(agentLink)}`, {
  method: 'POST',
  body: JSON.stringify({ items: [{ photoId: picks[1].id, stars: 4, clientRef: 'link-try-1' }] }),
});
check(linkInbound.status === 401, '拿只读 linkToken 写回流 → 401（读凭据不能升级成写）', `status=${linkInbound.status}`);
const revoked = await req(`/api-tokens?id=${encodeURIComponent(issued.body?.id ?? '')}`, { method: 'DELETE' });
check(revoked.status === 204, '撤销这条 API token', `status=${revoked.status}`);
const dead3 = await bare(`/photos/${picks[1].id}/thumb?t=${encodeURIComponent(token3)}`);
check(dead3.status === 401, '撤销后范围 token 读缩略图立刻 401', `status=${dead3.status}`);
const dead3In = await bare(`/jobs/${job3?.id}/inbound?t=${encodeURIComponent(token3)}`, {
  method: 'POST',
  body: JSON.stringify({ items: [{ photoId: picks[1].id, stars: 5 }] }),
});
check(dead3In.status === 401, '撤销后范围 token 写回流也 401', `status=${dead3In.status}`);

// ── 9. 并发重发同一个 clientRef：只写一次 ─────────────────────────────────
console.log('\n── 并发重发同一个 clientRef ──');
const created4 = (await post('/jobs', { kind: 'annotate', selection: { ids: [picks[2].id] }, params: { label: '并发测试' }, mode: 'apply' })).body;
const job4 = await pollJob(created4?.id, ['running']);
const token4 = (job4?.artifacts?.find((a) => a.kind === 'url')?.path ?? '').slice(5);
const dupBody = JSON.stringify({ items: [{ photoId: picks[2].id, stars: 3, clientRef: 'race-1' }] });
const [raceA, raceB] = await Promise.all([
  bare(`/jobs/${job4?.id}/inbound?t=${encodeURIComponent(token4)}`, { method: 'POST', body: dupBody }),
  bare(`/jobs/${job4?.id}/inbound?t=${encodeURIComponent(token4)}`, { method: 'POST', body: dupBody }),
]);
check(raceA.status === 200 && raceB.status === 200, '两条并发重发都回 200（后到的当重放）', `${raceA.status}/${raceB.status}`);
const raceRows = await req(`/marks/history?jobId=${job4?.id}&limit=200`);
const raceWrites = (raceRows.body?.items ?? []).filter((c) => c.by === 'link:并发测试');
check(raceWrites.length === 1, '并发重发只写一次盘（clientRef 幂等抗竞态）', `写入 ${raceWrites.length} 条`);
const raceEvents = await req(`/jobs/${job4?.id}/events?limit=200`);
check((raceEvents.body?.items ?? []).some((e) => e.type === 'skipped' && e.clientRef === 'race-1'), '事件流里能看到一次 skipped', `${(raceEvents.body?.items ?? []).filter((e) => e.type === 'skipped').length} 条`);

await stopServer(server);

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
console.log(`（服务日志：${LOG}）\n`);
process.exit(fail ? 1 : 0);
