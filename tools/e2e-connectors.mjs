#!/usr/bin/env node
/**
 * 设置页连接器管理浏览器回归（F10）。先 cd web && VITE_API_BASE=/api/v1 npm run build，再从仓库根运行：
 *   node tools/e2e-connectors.mjs --scenario=settings
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
    throw new Error(`${message}\n${await evaluate(`document.querySelector('[data-testid="connector-settings"]')?.innerText ?? document.body.innerText.slice(0, 500)`)}`);
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
    cwd: join(REPO, 'server'), env: { ...process.env, ARTWORKS_CONFIG: config, [FAKE_ENV]: 'fake-value-not-a-secret' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  assert.equal(scenario, 'settings', `未知场景 ${scenario}（当前只有 settings）`);
  const dir = await mkdtemp(join(tmpdir(), 'frameflow-connectors-'));
  try {
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
