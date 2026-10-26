// FTP 入库集成：真实服务 + basic-ftp 客户端（明文与 FTPES），含安全边界与中断上传。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { Client } from 'basic-ftp';
import { loadConfig } from '../src/adapters/outbound/config-file.ts';
import { Library } from '../src/adapters/outbound/fs/library.ts';
import { buildServer } from '../src/adapters/inbound/http/server.ts';
import { LibraryEventLog } from '../src/application/library/events.ts';

const require = createRequire(path.join(import.meta.dirname, '../package.json'));
const sharp = require('sharp');
const jpeg = (r = 10) => sharp({ create: { width: 48, height: 32, channels: 3, background: { r, g: 80, b: 120 } } }).jpeg().toBuffer();
const FTP_PASS = 'ftp-test-password-123';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ftp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=frameflow-test',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(tmp, 'ftp-pass.txt'), `${FTP_PASS}\n`);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function boot(name, { tls }) {
  const dir = path.join(tmp, name);
  const library = path.join(dir, 'lib');
  fs.mkdirSync(library, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    host: '127.0.0.1', port: 0, password: '', dataDir: path.join(dir, 'data'), logLevel: 'silent',
    roots: [{ id: 'cam', label: '相机', path: library }],
    ingest: {
      rootId: 'cam', subdir: 'inbox/{date}', stableMs: 200, pairWindowMs: 300, watch: false,
      ftp: { host: '127.0.0.1', port: 0, pasvMin: 0, pasvMax: 0, pasvUrl: '127.0.0.1', user: 'camera', passwordFile: path.join(tmp, 'ftp-pass.txt'),
        ...(tls ? { tls: { cert: path.join(tmp, 'cert.pem'), key: path.join(tmp, 'key.pem') } } : {}) },
    },
  }));
  const cfg = loadConfig([`--config=${configFile}`]);
  const lib = new Library(cfg);
  await lib.refresh();
  const events = new LibraryEventLog();
  let mod;
  const app = await buildServer(cfg, lib, { events, onIngest: (m) => { mod = m; } });
  await app.ready();
  const waitEvent = (pred, ms = 10_000) => new Promise((resolve, reject) => {
    const hit = events.since(0).events.find(pred);
    if (hit) return resolve(hit);
    const t = setTimeout(() => { off(); reject(new Error('等不到库事件')); }, ms);
    const off = events.subscribe((e) => { if (pred(e)) { clearTimeout(t); off(); resolve(e); } });
  });
  return { app, lib, library, mod, events, waitEvent, port: mod.ftpPort(), inbox: mod.inboxRel() };
}

/** 手写协议：登录 → PASV → STOR → 发一半后 RST 数据连接 */
async function rawAbortedStor(port, name) {
  const ctrl = net.connect(port, '127.0.0.1');
  let buf = '';
  const lines = [];
  let notify = null;
  ctrl.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); } notify?.(); });
  const expect = (re) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等不到 ${re}：${lines.join(' | ')}`)), 5000);
    const check = () => { const k = lines.findIndex((l) => re.test(l)); if (k >= 0) { clearTimeout(t); const l = lines[k]; lines.splice(0, k + 1); resolve(l); } };
    notify = check; check();
  });
  await expect(/^220/);
  ctrl.write('USER camera\r\n'); await expect(/^331/);
  ctrl.write(`PASS ${FTP_PASS}\r\n`); await expect(/^230/);
  ctrl.write('EPSV\r\n');
  const dport = Number(/\|\|\|(\d+)\|/.exec(await expect(/^229/))[1]);
  ctrl.write(`STOR ${name}\r\n`);
  const data = net.connect(dport, '127.0.0.1');
  await new Promise((r) => data.once('connect', r));
  await expect(/^150/);
  data.write(Buffer.alloc(8192, 7));
  await new Promise((r) => setTimeout(r, 100));
  data.resetAndDestroy();
  await expect(/^4\d\d/);
  ctrl.end('QUIT\r\n');
}

const connect = async (port, opts = {}) => {
  const c = new Client(5000);
  await c.access({ host: '127.0.0.1', port, user: 'camera', password: FTP_PASS, ...opts });
  return c;
};

test('明文 FTP：上传 JPEG → 入库 + 库事件（source=ftp），不留半成品', async () => {
  const s = await boot('plain', { tls: false });
  try {
    const c = await connect(s.port);
    assert.equal(await c.pwd(), '/');
    await c.uploadFrom(Readable.from(await jpeg(30)), 'DSC0001.JPG');
    c.close();
    const ev = await s.waitEvent((e) => e.type === 'photos.added');
    assert.equal(ev.source, 'ftp');
    assert.equal(ev.relDir, s.inbox);
    const files = fs.readdirSync(path.join(s.library, ...s.inbox.split('/')));
    assert.deepEqual(files, ['DSC0001.JPG']);
    assert.ok(s.lib.get(ev.photoIds[0]));
    const st = s.mod.status().sources.find((x) => x.kind === 'ftp');
    assert.equal(st.uploads, 1);
    assert.equal(JSON.stringify(st).includes(FTP_PASS), false, '状态里不能有密码');
  } finally {
    await s.app.close();
  }
});

test('FTPES（AUTH TLS + PROT P）：RAW+JPEG 配成一张；要求加密时明文登录被拒', async () => {
  const s = await boot('tls', { tls: true });
  try {
    await assert.rejects(connect(s.port), /530|AUTH TLS/);
    const c = await connect(s.port, { secure: true, secureOptions: { rejectUnauthorized: false } });
    await c.ensureDir('/sub');
    const buf = await jpeg(90);
    await c.uploadFrom(Readable.from(buf), 'DSC0002.ARW');
    await c.uploadFrom(Readable.from(buf), 'DSC0002.JPG');
    c.close();
    const ev = await s.waitEvent((e) => e.type === 'photos.added');
    assert.equal(ev.photoIds.length, 1, '配成一张');
    assert.equal(ev.relDir, `${s.inbox}/sub`);
    const rec = s.lib.get(ev.photoIds[0]);
    assert.ok(rec.raw && rec.jpeg);
  } finally {
    await s.app.close();
  }
});

test('安全边界：错密码、越狱、下载/删除都不行；中断上传不留文件；同名不覆盖', async () => {
  const s = await boot('sec', { tls: false });
  try {
    await assert.rejects(new Client(5000).access({ host: '127.0.0.1', port: s.port, user: 'camera', password: 'wrong-password' }), /530/);
    await assert.rejects(new Client(5000).access({ host: '127.0.0.1', port: s.port, user: 'root', password: FTP_PASS }), /530/);
    const c = await connect(s.port);
    await assert.rejects(c.cd('../../..'), /550/);
    assert.equal(await c.pwd(), '/');
    await assert.rejects(c.cd('/../../etc'), /550/);
    await assert.rejects(c.send('MKD .hidden'), /550/);
    await c.uploadFrom(Readable.from(await jpeg(5)), 'A.JPG');
    await c.uploadFrom(Readable.from(await jpeg(6)), 'A.JPG'); // 同名 → A_1.JPG
    await assert.rejects(c.downloadTo(fs.createWriteStream(path.join(tmp, 'x')), 'A.JPG'), /550/);
    await assert.rejects(c.remove('A.JPG'), /550/);
    await assert.rejects(c.uploadFrom(Readable.from(Buffer.from('x')), '../escape.JPG'), /553/);
    c.close();
    // 中断：相机断电 = 数据连接被 RST（流模式下正常 FIN 就是「传完」，协议层分不出来）
    await rawAbortedStor(s.port, 'BROKEN.JPG');
    await new Promise((r) => setTimeout(r, 300));
    const inbox = path.join(s.library, ...s.inbox.split('/'));
    assert.deepEqual(fs.readdirSync(inbox).sort(), ['A.JPG', 'A_1.JPG']);
    assert.equal(fs.existsSync(path.join(s.library, 'escape.JPG')), false);
    assert.equal(fs.existsSync(path.join(s.library, 'inbox', 'escape.JPG')), false);
  } finally {
    await s.app.close();
  }
});
