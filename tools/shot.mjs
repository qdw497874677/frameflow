#!/usr/bin/env node
/**
 * 截图工具：用 CDP 精确控制 CSS 视口截图。
 *
 * 为什么不用 `chromium --headless=new --window-size=390,844 --screenshot`：
 * Linux 上 chromium 的窗口有最小宽度（约 500px），窄窗口会先按 500px 布局、
 * 再被裁成 390px —— 截出来的「手机版」其实是桌面布局的左边一部分。
 * 走 CDP 的 Emulation.setDeviceMetricsOverride 才能拿到真正的 390px 视口。
 *
 * 用法：
 *   node tools/shot.mjs --url "http://127.0.0.1:5173/?mode=a" --out /tmp/shots/a.png
 *   node tools/shot.mjs --url ... --out ... --width 390 --height 844 --dsf 2
 *   node tools/shot.mjs --url ... --out ... --width 1440 --height 900 --wait 3000
 *   node tools/shot.mjs --url ... --out ... --script tools/pan-left.mjs   # 截图前先跑一段脚本
 *
 * 参数：
 *   --url   页面地址（必填）
 *   --out   图片路径（必填）
 *   --width/--height   CSS 视口尺寸，默认 390x844
 *   --dsf    deviceScaleFactor，默认 2（手机截 780px 宽的图，肉眼看细节）
 *   --mobile 是否按移动设备模拟（默认 width<600 时为 true）
 *   --wait   加载完成后再等多少毫秒，默认 1500（等字体/动画落定）
 *   --script 可选：先执行的脚本文件（导出 async (send) => void，send 是 CDP 命令函数）
 *   --chrome chromium 可执行文件，默认 chromium
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const url = arg('url');
const out = arg('out');
if (!url || !out) {
  console.error('用法: node tools/shot.mjs --url <url> --out <file> [--width 390] [--height 844] [--dsf 2] [--wait 1500] [--script file.mjs]');
  process.exit(2);
}
const width = Number(arg('width', '390'));
const height = Number(arg('height', '844'));
const dsf = Number(arg('dsf', '2'));
const waitMs = Number(arg('wait', '1500'));
const chrome = arg('chrome', 'chromium');
const mobile = flag('mobile') || width < 600;
const scriptPath = arg('script', null);

const PORT = 9200 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'shot-profile-'));

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('chromium 没起来（DevTools 端口无响应）');
}

async function main() {
  const ws = new WebSocket(await wsUrl());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else res(msg.result);
      return;
    }
    events.push(msg);
    for (const w of waiters.slice()) {
      if (w.method === msg.method) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(msg.params);
      }
    }
  };

  let sessionId = null;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const waitEvent = (method, timeout = 15000) =>
    new Promise((res, rej) => {
      const w = { method, res };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          rej(new Error(`等 ${method} 超时`));
        }
      }, timeout);
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: dsf,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });

  const loaded = waitEvent('Page.loadEventFired', 20000);
  await send('Page.navigate', { url });
  await loaded.catch(() => {});
  await sleep(waitMs);

  if (scriptPath) {
    const mod = await import(path.resolve(scriptPath));
    await mod.default(send);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`${out}  (${width}x${height} @${dsf}x → ${width * dsf}x${height * dsf})`);

  ws.close();
}

main()
  .catch((e) => {
    console.error('截图失败:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill('SIGKILL');
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  });
