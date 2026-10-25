/**
 * 测试报告中优先级问题的回归测试（Bug 4–8）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixture } from './connector-fixture.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-reg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('Bug 4：API token 不能签发/列出/撤销 token，也不能吊销会话；scope 只认枚举', async (t) => {
  const fx = await makeFixture({ photos: 1 });
  t.after(() => fx.dispose());
  await fx.start();
  assert.equal((await fx.call('POST', '/api/v1/api-tokens', { label: 'x', scope: 'godmode' })).status, 400);
  assert.equal((await fx.call('POST', '/api/v1/api-tokens', { label: '' })).status, 400);
  const minted = await fx.call('POST', '/api/v1/api-tokens', { label: 'ai' });
  assert.equal(minted.status, 201);
  assert.equal(minted.json.scope, 'full');
  const bearer = { host: 'ff.local', authorization: `Bearer ${minted.json.token}` };
  assert.equal((await fx.app.inject({ url: '/api/v1/roots', headers: bearer })).statusCode, 200, 'token 本身可用');
  for (const [method, url] of [['POST', '/api/v1/api-tokens'], ['GET', '/api/v1/api-tokens'], ['DELETE', `/api/v1/api-tokens?id=${minted.json.id}`]]) {
    const r = await fx.app.inject({ method, url, headers: bearer, payload: method === 'POST' ? { label: 'child' } : undefined });
    assert.equal(r.statusCode, 403, `${method} ${url}`);
    assert.equal(r.json().code, 'SESSION_REQUIRED');
  }
  await fx.app.inject({ method: 'DELETE', url: '/api/v1/session', headers: bearer });
  assert.equal((await fx.call('GET', '/api/v1/api-tokens')).status, 200, 'bearer 调 DELETE /session 不会踢掉浏览器会话');
  assert.equal((await fx.call('GET', '/api/v1/api-tokens')).json.tokens.length, 1);
});

test('Bug 6：只读 XMP 不被覆盖、报错不带路径；权限恢复后自动补写', async (t) => {
  const { MarksStore } = await import('../src/adapters/outbound/fs/marks-store.ts');
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = fs.mkdtempSync(join(tmpdir(), 'bug6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const xmp = join(dir, 'secret-folder-name', 'a.xmp');
  fs.mkdirSync(join(dir, 'secret-folder-name'));
  const original = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1"/></rdf:RDF></x:xmpmeta>';
  fs.writeFileSync(xmp, original);
  fs.chmodSync(xmp, 0o444);
  const store = new MarksStore(join(dir, 'data'));
  const [r] = await store.apply([{ id: 'p', stars: 4 }], () => ({ displayName: 'p', sidecarPath: xmp }));
  assert.equal(r.ok, true, '标注本身成功');
  assert.equal(store.starsOf('p'), 4);
  assert.match(r.error, /XMP 文件是只读的/);
  assert.doesNotMatch(r.error, /secret-folder-name|\//, '报错不带路径');
  assert.equal(fs.readFileSync(xmp, 'utf8'), original, '只读 XMP 原样保留');
  assert.equal(store.xmpPendingCount, 1);
  fs.chmodSync(xmp, 0o644);
  assert.equal(await store.retryXmp(), 0);
  assert.match(fs.readFileSync(xmp, 'utf8'), /xmp:Rating="4"/, '补写成最新状态');
});

test('Bug 8：backup 跳过 --config= 开关，把位置参数当目标目录', async (t) => {
  const { positionalArgs } = await import('../src/adapters/inbound/cli/args.ts');
  assert.deepEqual(positionalArgs(['--config=/x/c.json', '/backups']), ['/backups']);
  const fs = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(join(tmpdir(), 'bug8-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(dataDir, 'marks.jsonl'), '');
  const cfg = join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ dataDir, roots: [] }));
  const dest = join(dir, 'out');
  const out = execFileSync(process.execPath, ['src/adapters/inbound/cli/backup.ts', `--config=${cfg}`, dest], { encoding: 'utf8' });
  assert.match(out, /已备份/);
  assert.equal(fs.existsSync(join(dir, '--config=' + cfg)), false);
  assert.ok(fs.readdirSync(dest).length > 0, '备份落在位置参数给的目录里');
});
