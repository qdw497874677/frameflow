#!/usr/bin/env node
/**
 * 设置页连接器管理浏览器回归（F10）。先 cd web && VITE_API_BASE=/api/v1 npm run build，再从仓库根运行：
 *   node tools/e2e-connectors.mjs --scenario=settings
 *   node tools/e2e-connectors.mjs --scenario=dispatch   # F17：派发框勾选目标/预览/确认/取消零发送
 *   node tools/e2e-connectors.mjs --scenario=delivery   # F18：两实例三目标部分失败、单目标重试、unknown 风险确认
 * dispatch/delivery 用 FRAMEFLOW_FAKE_TRANSPORT=e2e 的离线假传输（externalId 以 oc_fail 开头的失败），绝不触网。
 * 独立临时库与数据目录；后端未注册任何平台适配器（零外传），Secret 只用假环境变量；CDP 真鼠标/键盘。
 * 两轮：①设密码并登录（390px）：新建默认停用、目标编辑、secretConfigured、启用后真实错误状态、
 * 无消息测试、非法输入失败保留表单、无横向溢出、主控件≥44px；②未设密码：入口禁用且后端仍拒绝。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const FILE = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(FILE), '..');
const SHOT = join(REPO, 'tools/shot.mjs');
const PASSWORD = 'e2e-local-password';
const FAKE_ENV = 'FRAMEFLOW_E2E_FAKE_SECRET';

export default async function probe(send) {
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const waitFor = async (expression, message) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`${message}\n${await evaluate(`(document.querySelector('[role="dialog"]') ?? document.querySelector('[data-testid="delivery-status"]') ?? document.querySelector('[data-testid="connector-settings"]') ?? document.body).innerText.slice(0, 1500)`)}`);
  };
  const clickAt = async (point) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const center = (finder) => evaluate(`(() => {
    const el = (${finder})();
    if (!el) throw new Error('missing element');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  const button = (text, scope = 'document') => `() => [...${scope}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
  const clickText = async (text) => clickAt(await center(button(text)));
  const fill = async (label, value, nth = 0) => {
    await clickAt(await center(`() => document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')[${nth}]`));
    await evaluate(`document.activeElement.select()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    if (value) await send('Input.insertText', { text: value });
  };
  const card = `document.querySelector('[data-testid="connector-settings"]')`;
  const status = () => evaluate(`${card}.querySelector('[role="status"]').textContent`);
  const noOverflow = async (where) => {
    const r = await evaluate(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth,
      wide: [...${card}.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.tagName + ':' + e.textContent.slice(0, 20)).slice(0, 5) })`);
    assert.ok(r.doc <= r.vw && r.wide.length === 0, `${where}出现横向溢出 ${JSON.stringify(r)}`);
  };
  const smallControls = () => evaluate(`[...${card}.querySelectorAll('button, input:not([type=checkbox]), select')]
    .filter(e => e.getBoundingClientRect().height < 44).map(e => e.textContent.trim() || e.getAttribute('aria-label'))`);

  const mode = await evaluate(`new URLSearchParams(location.search).get('e2eMode')`);

  if (mode === 'dispatch' || mode === 'delivery') return flow(mode, { evaluate, waitFor, clickAt, center, send });
  if (mode === 'noauth') {
    await waitFor(`${card}`, '设置页未显示连接器卡片');
    assert.match(await evaluate(`${card}.innerText`), /先在后端设置应用密码/);
    assert.equal(await evaluate(`(${button("新建飞书连接器", card)})() === undefined`), true, '未认证不应出现新建入口');
    const api = await evaluate(`fetch('/api/v1/connectors').then(async r => ({ s: r.status, c: (await r.json()).code }))`);
    assert.deepEqual(api, { s: 403, c: 'PASSWORD_REQUIRED' }, '后端仍须独立拒绝');
    console.log('ok 未设密码：入口禁用，后端 403 PASSWORD_REQUIRED');
    return;
  }

  // 登录（真实 session cookie）
  if (!(await evaluate(`fetch('/api/v1/connectors').then(r => r.ok)`))) {
    const ok = await evaluate(`fetch('/api/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }) }).then(r => r.ok)`);
    assert.ok(ok, '登录失败');
    await send('Page.reload', { ignoreCache: true });
    await sleep(1500);
  }
  await waitFor(`(${button("新建飞书连接器")})()`, '已登录设置页应有新建入口');
  await noOverflow('空列表');
  await clickText('新建飞书连接器');
  await waitFor(`document.querySelector('form[aria-label="连接器表单"]')`, '表单未打开');
  await fill('连接器名称', '测试飞书');
  await fill('App ID', 'cli_e2e_fake');
  await fill('Secret 环境变量名', FAKE_ENV);
  await clickText('添加目标');
  await waitFor(`document.querySelector('[data-testid="target-row"]')`, '目标行未出现');
  await fill('目标名称', '摄影组群');
  await fill('外部 ID', 'oc_e2e_fake_group');
  await fill('允许用户', 'ou_e2e_a, ou_e2e_b');
  await clickAt(await center(`() => [...document.querySelectorAll('[aria-label="授权项目"] label')].find(l => l.textContent.includes('连接器测试'))`));
  await noOverflow('表单');
  const small = await smallControls();
  assert.deepEqual(small, [], `主控件须≥44px：${small}`);
  await clickText('保存');
  await waitFor(`${card}.querySelector('[data-testid="connector-row"]')`, '保存后未出现连接器');
  assert.match(await status(), /已保存（保存不会发送任何消息）/);
  let row = await evaluate(`${card}.querySelector('[data-testid="connector-row"]').innerText`);
  assert.match(row, /未启用/); assert.match(row, /已配置/); assert.match(row, /1 个目标/);
  const saved = await evaluate(`fetch('/api/v1/connectors').then(r => r.json())`);
  assert.equal(saved.items[0].enabled, false, '新建默认停用');
  assert.deepEqual(saved.items[0].targets[0].projectIds, ['e2e']);
  assert.deepEqual(saved.items[0].targets[0].allowedActorIds, ['ou_e2e_a', 'ou_e2e_b']);
  assert.ok(!JSON.stringify(saved).includes('fake-value'), 'Secret 值不得出现在响应里');
  console.log('ok 新建：默认停用、目标/允许用户/项目保存、secretConfigured 显示');

  await clickText('启用');
  await waitFor(`${card}.querySelector('[data-testid="connector-state"]')?.textContent === '出错'`, '启用后应如实显示错误状态');
  assert.match(await evaluate(`${card}.querySelector('[data-testid="connector-row"]').innerText`), /CONNECTOR_KIND_UNSUPPORTED/);
  await clickText('测试连接');
  await waitFor(`/CONNECTOR_KIND_UNSUPPORTED|失败/.test(${card}.querySelector('[role="status"]').textContent)`, '无适配器时测试应失败并显示原因');
  console.log('ok 启用：真实状态/错误码（无适配器，零外传）；测试连接失败如实显示');

  await clickText('编辑');
  await waitFor(`document.querySelector('form[aria-label="连接器表单"]')`, '编辑表单未打开');
  await fill('App ID', 'bad id!');
  await clickText('保存');
  await waitFor(`/INVALID|不合法/.test(${card}.querySelector('[role="status"]').textContent)`, '非法输入应显示错误');
  assert.equal(await evaluate(`document.querySelector('[aria-label="App ID"]')?.value`), 'bad id!', '失败须保留表单');
  assert.equal(await evaluate(`document.querySelector('[aria-label="目标名称"]')?.value`), '摄影组群');
  await noOverflow('错误态');
  console.log('ok 保存失败：错误码显示，表单内容保留；390px 无横向溢出');
}

async function flow(mode, { evaluate, waitFor, clickAt, center }) {
  const api = (method, path, body) => evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ s: r.status, j: r.status === 204 ? null : await r.json() }))`);
  if (!(await evaluate(`fetch('/api/v1/connectors').then(r => r.ok)`))) {
    assert.equal((await api('POST', '/api/v1/session', { password: PASSWORD })).s < 300, true, '登录失败');
  }
  // 两个实例、三个目标（其中 c2/bad 会失败）；全部通过公开 API 建立
  const inst = (id, targets) => ({ id, kind: 'feishu', label: id === 'c1' ? '飞书甲' : '飞书乙', appId: `cli_${id}`, secretEnv: FAKE_ENV, tenantId: 't1',
    targets: targets.map(([tid, label, ext]) => ({ id: tid, connectorId: id, label, kind: 'group', externalId: ext, projectIds: ['e2e'], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false })),
    creatorActorIds: [], creatorProjectIds: [] });
  let rev = (await api('GET', '/api/v1/connectors')).j.revision;
  for (const i of [inst('c1', [['g1', '摄影群', 'oc_ok_one']]), inst('c2', [['g1', '客户群', 'oc_ok_two'], ['bad', '坏群', 'oc_fail_x']])]) {
    if ((await api('GET', `/api/v1/connectors/${i.id}`)).s === 200) continue;
    let r = await api('POST', '/api/v1/connectors', { expectedRevision: rev, instance: i });
    assert.ok(r.s < 300, JSON.stringify(r)); rev = r.j.revision;
    r = await api('PATCH', `/api/v1/connectors/${i.id}`, { expectedRevision: rev, patch: { enabled: true } });
    assert.ok(r.s < 300, JSON.stringify(r)); rev = r.j.revision;
  }
  await evaluate(`location.href = '/?e2eMode=${mode}&step=ui'`);
  await sleep(2000);
  const dlg = `document.querySelector('[role="dialog"]')`;
  const openDispatch = async () => {
    await waitFor(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('派发批注'))`, '挑片页没有派发入口');
    await clickAt(await center(`() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('派发批注'))`));
    await waitFor(`${dlg}?.querySelector('[data-testid="dispatch-external"]')`, '派发框没有外传区');
    await waitFor(`/仅应用内/.test(${dlg}.querySelector('[data-testid="dispatch-preview"]').textContent)`, '默认应仅应用内');
  };
  const tick = async (text) => clickAt(await center(`() => [...${dlg}.querySelectorAll('label')].find(l => l.textContent.includes(${JSON.stringify(text)}))?.querySelector('input')`));
  const sentCount = async () => (await api('GET', '/api/v1/jobs?limit=50')).j.items?.length ?? 0;
  const noOverflow = async (where) => {
    const r = await evaluate(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth })`);
    assert.ok(r.doc <= r.vw, `${where}横向溢出 ${JSON.stringify(r)}`);
  };
  const dlgSmall = () => evaluate(`[...${dlg}.querySelectorAll('button')].filter(e => e.getBoundingClientRect().height < 44 && !e.getAttribute('aria-label')?.includes('关闭') && e.textContent.trim() && e.textContent.trim() !== 'Close').map(e => e.textContent.trim())`);

  if (mode === 'dispatch') {
    // 取消：零发送、零任务
    const before = await sentCount();
    await openDispatch();
    await tick('飞书甲 · 摄影群');
    await waitFor(`/将发送派发通知到：飞书甲 · 摄影群/.test(${dlg}.querySelector('[data-testid="dispatch-preview"]').textContent)`, '勾选后预览应列出目标');
    assert.equal(await evaluate(`[...${dlg}.querySelectorAll('button')].find(b => b.textContent.trim() === '派发').disabled`), true, '未勾确认不可派发');
    await noOverflow('派发框');
    assert.deepEqual(await dlgSmall(), [], '派发框按钮须≥44px');
    await clickAt(await center(`() => [...${dlg}.querySelectorAll('button')].find(b => b.textContent.trim() === '取消')`));
    await sleep(800);
    assert.equal(await sentCount(), before, '取消不应建任务');
    console.log('ok 派发框：默认仅应用内；勾选后预览列目标；须确认；取消零发送');
    // 确认：建任务并外传到所选目标
    await openDispatch();
    await tick('飞书甲 · 摄影群');
    await waitFor(`/飞书甲/.test(${dlg}.querySelector('[data-testid="dispatch-preview"]').textContent)`, '预览未刷新');
    await tick('我确认');
    await clickAt(await center(`() => [...${dlg}.querySelectorAll('button')].find(b => b.textContent.trim() === '派发' && !b.disabled)`));
    await waitFor(`/已派发/.test(${dlg}.innerText)`, '确认后应显示已派发');
    const jobs = (await api('GET', '/api/v1/jobs?limit=50')).j.items;
    const d = (await api('GET', `/api/v1/jobs/${jobs[0].id}/deliveries`)).j;
    for (let i = 0; i < 30 && !d.items.every((p) => p.state === 'sent'); i++) { await sleep(100); Object.assign(d, (await api('GET', `/api/v1/jobs/${jobs[0].id}/deliveries`)).j); }
    assert.deepEqual([...new Set(d.items.map((p) => `${p.connectorId}/${p.targetId}:${p.state}`))], ['c1/g1:sent'], '只投递到所选目标');
    console.log('ok 确认派发：只投递到勾选的目标（假传输）');
    return;
  }
  // delivery：三个目标部分失败 → 任务详情按目标显示；失败可重试
  await openDispatch();
  for (const t of ['飞书甲 · 摄影群', '飞书乙 · 客户群', '飞书乙 · 坏群']) await tick(t);
  await waitFor(`/坏群/.test(${dlg}.querySelector('[data-testid="dispatch-preview"]').textContent)`, '预览未列出三个目标');
  await tick('我确认');
  await clickAt(await center(`() => [...${dlg}.querySelectorAll('button')].find(b => b.textContent.trim() === '派发' && !b.disabled)`));
  await waitFor(`/已派发/.test(${dlg}.innerText)`, '确认后应显示已派发');
  const job = (await api('GET', '/api/v1/jobs?limit=50')).j.items[0];
  await evaluate(`location.href = '/?view=jobs&e2eMode=delivery&step=jobs'`);
  await sleep(2000);
  await waitFor(`[...document.querySelectorAll('button, li, [role="button"]')].find(e => e.textContent.includes('批注'))`, '任务列表为空');
  await clickAt(await center(`() => [...document.querySelectorAll('button, [role="button"]')].find(e => e.textContent.includes('批注') && !e.textContent.includes('派发'))`));
  const box = `document.querySelector('[data-testid="delivery-status"]')`;
  await waitFor(`${box} && ${box}.querySelectorAll('[data-testid="delivery-row"]').length === 3`, '外传状态应按目标分 3 行');
  await waitFor(`[...${box}.querySelectorAll('[data-testid="delivery-row"]')].filter(r => r.dataset.state === 'sent').length === 2`, '两个目标应已送达');
  const rows = await evaluate(`[...${box}.querySelectorAll('[data-testid="delivery-row"]')].map(r => r.dataset.state + ':' + r.innerText.split('\\n')[0])`);
  assert.equal(rows.filter((r) => r.startsWith('failed')).length, 1, `坏群应失败 ${rows}`);
  await noOverflow('任务详情 390px');
  const small = await evaluate(`[...${box}.querySelectorAll('button')].filter(e => e.getBoundingClientRect().height < 44).map(e => e.textContent)`);
  assert.deepEqual(small, [], '重试按钮须≥44px');
  console.log('ok 外传状态：两实例三目标，2 送达 1 失败，按目标显示；390px 无溢出');
  await clickAt(await center(`() => [...${box}.querySelectorAll('[data-state="failed"] button')].find(b => b.textContent.trim() === '重试')`));
  await waitFor(`/重新排队|ATTEMPT|失败/.test(${box}.querySelector('[role="status"]').textContent)`, '重试无反馈');
  await sleep(500);
  const d = (await api('GET', `/api/v1/jobs/${job.id}/deliveries`)).j.items;
  const bad = d.filter((p) => p.targetId === 'bad');
  assert.ok(bad.every((p) => p.attempts >= 2 && p.state === 'failed'), `失败目标应被重试一次且仍失败 ${JSON.stringify(bad)}`);
  assert.ok(d.filter((p) => p.targetId !== 'bad').every((p) => p.attempts === 1), '已送达目标不得重发');
  const dup = await api('POST', `/api/v1/jobs/${job.id}/deliveries/retry`, { connectorId: 'c1', targetId: 'g1', acceptDuplicateRisk: false });
  assert.equal(dup.j.code, 'NOTHING_TO_RETRY', '已送达目标不可重试');
  console.log('ok 单目标重试：只重发失败目标；已送达不重发');
}

async function run(dir, { password, width, mode }) {
  const require = createRequire(join(REPO, 'server/package.json'));
  const sharp = require('sharp');
  const library = join(dir, `lib-${mode}`);
  await mkdir(library, { recursive: true });
  await writeFile(join(library, 'A.jpg'), await sharp({ create: { width: 60, height: 40, channels: 3, background: '#888' } }).jpeg().toBuffer());
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const config = join(dir, `config-${mode}.json`);
  await writeFile(config, JSON.stringify({ host: '127.0.0.1', port, password, dataDir: join(dir, `data-${mode}`), roots: [{ id: 'e2e', label: '连接器测试', path: library }] }));
  let log = '';
  const server = spawn(process.execPath, ['src/index.ts', `--config=${config}`], {
    cwd: join(REPO, 'server'), env: { ...process.env, ARTWORKS_CONFIG: config, [FAKE_ENV]: 'fake-value-not-a-secret', FRAMEFLOW_FEISHU_SDK: 'disabled', ...(mode === 'dispatch' || mode === 'delivery' ? { FRAMEFLOW_FAKE_TRANSPORT: 'e2e' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => { log += b; });
  server.stderr.on('data', (b) => { log += b; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      try { ready = (await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* 启动中 */ }
      if (!ready) await sleep(100);
    }
    assert.ok(ready, `后端未就绪\n${log}`);
    const chrome = ['chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((c) => c === 'chromium' ? false : existsSync(c)) ?? 'chromium';
    const browser = spawn(process.execPath, [SHOT, '--url', `${base}/?view=settings&e2eMode=${mode}`, '--out', `/tmp/frameflow-connectors-${mode}.png`, '--width', String(width), '--height', '844', '--dsf', '1', '--wait', '1500', '--script', FILE, '--chrome', chrome], { stdio: 'inherit' });
    const [code] = await once(browser, 'exit');
    assert.equal(code, 0, `浏览器回归失败（${mode}）\n${log.slice(-2000)}`);
  } finally {
    if (server.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await Promise.race([stopped, sleep(3000)]);
      if (server.exitCode === null) { server.kill('SIGKILL'); await stopped; }
    }
  }
}

async function main() {
  const scenario = (process.argv.find((a) => a.startsWith('--scenario=')) ?? '--scenario=settings').split('=')[1];
  assert.ok(['settings', 'dispatch', 'delivery'].includes(scenario), `未知场景 ${scenario}`);
  const dir = await mkdtemp(join(tmpdir(), 'frameflow-connectors-'));
  try {
    if (scenario !== 'settings') {
      await run(dir, { password: PASSWORD, width: 390, mode: scenario });
      console.log(`PASS ${scenario} 回归（临时库，离线假传输）`);
      return;
    }
    await run(dir, { password: PASSWORD, width: 390, mode: 'auth' });
    await run(dir, { password: '', width: 390, mode: 'noauth' });
    console.log('PASS 设置页连接器管理回归（临时库，零外传）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
