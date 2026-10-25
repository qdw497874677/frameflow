/**
 * 审查高优先级修复：飞书 JSONL 损坏策略/权限、登录限流、会话吊销与 Secure cookie。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { JsonlLog, StoreCorruptError } from '../src/adapters/feishu/jsonl.ts';
import { SessionStore } from '../src/adapters/feishu/sessions.ts';
import { LoginLimiter } from '../src/adapters/inbound/http/login-limiter.ts';
import { Auth } from '../src/adapters/inbound/http/auth.ts';
import { makeFixture, PASSWORD } from './connector-fixture.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hard-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('JSONL：新建文件 0600；尾部半行容忍，追加时截掉半行，重载不判损坏', (t) => {
  const f = path.join(tmp(t), 'feishu', 'x.jsonl');
  const log = new JsonlLog(f);
  log.append({ a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.appendFileSync(f, '{"a":2');
  const l2 = new JsonlLog(f);
  assert.deepEqual(l2.load(), [{ a: 1 }]);
  assert.equal(l2.corrupt, null);
  l2.append({ a: 3 });
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"a":3}\n');
  const l3 = new JsonlLog(f);
  assert.deepEqual(l3.load(), [{ a: 1 }, { a: 3 }]);
  assert.equal(l3.corrupt, null);
});

test('JSONL：中间完整行损坏 → 只读，append 抛 STORE_CORRUPT(503)，文件字节不变', (t) => {
  const f = path.join(tmp(t), 'y.jsonl');
  const bytes = '{"a":1}\nnot json\n{"a":2}\n';
  fs.writeFileSync(f, bytes);
  const log = new JsonlLog(f);
  assert.deepEqual(log.load(), [{ a: 1 }, { a: 2 }]);
  assert.match(log.corrupt, /LINE_2/);
  assert.throws(() => log.append({ a: 3 }), (e) => e instanceof StoreCorruptError && e.code === 'STORE_CORRUPT' && e.statusCode === 503);
  assert.equal(fs.readFileSync(f, 'utf8'), bytes);
});

test('JSONL：飞书 SessionStore 损坏时拒绝写入；经 Fastify 映射为 503 STORE_CORRUPT', async (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'feishu'));
  fs.writeFileSync(path.join(d, 'feishu', 'sessions.jsonl'), 'garbage\n{}\n');
  const store = new SessionStore(d);
  const app = Fastify();
  assert.equal(store.check('s_any', { connectorId: 'c', tenantId: 't', targetId: 'g' }).code, 'STORE_CORRUPT', '损坏时校验一律拒绝（可能丢了 revoke）');
  app.get('/x', async () => { store.create({ jobId: 'j', connectorId: 'c', tenantId: 't', targetId: 'g' }); return { ok: true }; });
  const r = await app.inject({ url: '/x' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, 'STORE_CORRUPT');
  await app.close();
});

test('登录限流：前 5 次失败放行，之后指数退避并封顶；成功清零；按 IP 隔离', () => {
  let now = 0;
  const l = new LoginLimiter({ now: () => now });
  for (let i = 0; i < 5; i++) assert.equal(l.fail('1.1.1.1'), 0);
  assert.equal(l.fail('1.1.1.1'), 1000);
  assert.equal(l.blockedFor('1.1.1.1'), 1000);
  assert.equal(l.blockedFor('2.2.2.2'), 0);
  now += 1000;
  assert.equal(l.fail('1.1.1.1'), 2000);
  now += 2000;
  for (let i = 0; i < 30; i++) l.fail('1.1.1.1');
  assert.equal(l.blockedFor('1.1.1.1'), 15 * 60_000);
  l.success('1.1.1.1');
  assert.equal(l.blockedFor('1.1.1.1'), 0);
});

test('会话：登出吊销所有 cookie；密码变更（重启时）使旧 cookie 失效；旧格式 cookie 无效', (t) => {
  const d = tmp(t);
  const a = new Auth(d, 'pw1');
  const c1 = a.sessionCookie(), c2 = a.sessionCookie();
  assert.ok(a.checkSession(c1) && a.checkSession(c2));
  a.revokeSessions();
  assert.ok(!a.checkSession(c1) && !a.checkSession(c2));
  const c3 = a.sessionCookie();
  assert.ok(new Auth(d, 'pw1').checkSession(c3), '同密码重启仍有效');
  assert.ok(!new Auth(d, 'pw2').checkSession(c3), '改密码后失效');
  assert.equal(fs.statSync(path.join(d, 'session-state.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(d, 'session-state.json'), 'utf8').includes('pw2'), '不存明文密码');
});

test('HTTP：登录 429 + Retry-After；DELETE /session 吊销；Secure 按配置/协议', async (t) => {
  const fx = await makeFixture({ photos: 1 });
  t.after(() => fx.dispose());
  const h = { host: 'ff.local', origin: 'http://ff.local' };
  const login = (password, extra = {}) => fx.app.inject({ method: 'POST', url: '/api/v1/session', payload: { password }, headers: { ...h, ...extra } });
  const ok = await login(PASSWORD);
  assert.equal(ok.statusCode, 204);
  const setc = [ok.headers['set-cookie']].flat()[0];
  assert.ok(!/;\s*Secure/i.test(setc), 'HTTP + auto 不加 Secure');
  const cookie = setc.split(';')[0];
  assert.equal((await fx.app.inject({ url: '/api/v1/roots', headers: { ...h, cookie } })).statusCode, 200);
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).statusCode, 401);
  const sixth = await login('wrong');
  assert.equal(sixth.statusCode, 401);
  assert.ok(sixth.headers['retry-after']);
  const blocked = await login(PASSWORD);
  assert.equal(blocked.statusCode, 429, '锁定期内正确密码也拒绝');
  assert.equal(blocked.json().code, 'TOO_MANY_ATTEMPTS');
  // 伪造 X-Forwarded-For 绕不过（默认不信任代理）
  assert.equal((await login(PASSWORD, { 'x-forwarded-for': '9.9.9.9' })).statusCode, 429);
  assert.equal((await fx.app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { ...h, cookie } })).statusCode, 204);
  assert.equal((await fx.app.inject({ url: '/api/v1/roots', headers: { ...h, cookie } })).statusCode, 401, '登出后旧 cookie 失效');
});

test('HTTP：trustProxy + X-Forwarded-Proto=https 时 auto 加 Secure；cookieSecure=always 强制', async (t) => {
  const { loadConfig } = await import('../src/adapters/outbound/config-file.ts');
  const { Library } = await import('../src/application/library.ts');
  const { buildServer } = await import('../src/adapters/inbound/http/server.ts');
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'lib'));
  for (const [mode, trust, proto, expect] of [['auto', true, 'https', true], ['auto', false, 'https', false], ['always', false, undefined, true], ['never', true, 'https', false]]) {
    const cf = path.join(d, `c-${mode}-${trust}.json`);
    fs.writeFileSync(cf, JSON.stringify({ password: 'p', dataDir: path.join(d, `data-${mode}-${trust}`), logLevel: 'silent', trustProxy: trust, cookieSecure: mode, roots: [{ id: 'r', label: 'r', path: path.join(d, 'lib') }] }));
    const cfg = loadConfig([`--config=${cf}`]);
    const lib = new Library(cfg); await lib.refresh();
    const app = await buildServer(cfg, lib);
    const r = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { password: 'p' }, headers: { host: 'ff.local', origin: proto ? 'https://ff.local' : 'http://ff.local', ...(proto ? { 'x-forwarded-proto': proto } : {}) } });
    assert.equal(r.statusCode, 204, `${mode}/${trust}`);
    assert.equal(/;\s*Secure/i.test([r.headers['set-cookie']].flat()[0]), expect, `${mode}/${trust}/${proto}`);
    await app.close();
  }
});
