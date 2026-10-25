/**
 * 测试报告中低优先级问题的回归测试（Bug 9、10、12）。前端部分（Bug 10/11、UX）见 web/src 下的 *.test.ts。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { makeFixture } from './connector-fixture.mjs';
import { listenFailureMessage } from '../src/adapters/inbound/cli/listen-error.ts';

test('Bug 9：越界星级、认不出的 sel、文件当项目、?t= 冒充凭据 —— 都明确拒绝', async (t) => {
  const fx = await makeFixture({ photos: 1 });
  t.after(() => fx.dispose());
  const list = await fx.call('GET', '/api/v1/photos?dir=/p');
  const id = list.json.items[0].id;
  for (const stars of [9, -1, 2.5]) {
    const r = await fx.call('PUT', '/api/v1/marks', { items: [{ id, stars }] });
    assert.equal(r.status, 400, `PUT /marks stars=${stars}`);
  }
  assert.equal((await fx.call('GET', `/api/v1/photos?dir=/p`)).json.items[0].stars, 0, '没被夹成 5 写进去');
  assert.equal((await fx.call('POST', '/api/v1/jobs/whatever/inbound', { items: [{ photoId: id, stars: 6 }] })).status, 400, '回流同样拒绝');
  assert.equal((await fx.call('PUT', '/api/v1/marks', { items: [{ id, stars: 5 }] })).status, 200);

  const bad = await fx.call('GET', '/api/v1/photos?dir=/p&sel=starz>=3');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /starz>=3/);
  assert.equal((await fx.call('GET', '/api/v1/photos?dir=/p&sel=stars>=3,del:false')).status, 200);

  const file = path.join(fx.dir, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  const root = await fx.call('POST', '/api/v1/roots', { path: file });
  assert.equal(root.status, 400);
  assert.match(root.json.error, /不是目录/);

  for (const url of ['/api/v1/photos?t=forged', '/api/v1/photos?dir=/p&t=forged', '/api/v1/photos?t=']) {
    const r = await fx.app.inject({ url, headers: { host: 'ff.local' } });
    assert.equal(r.statusCode, 401, url);
  }
});

test('Bug 12：端口被占用时给人话，不吐堆栈', () => {
  const err = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8787'), { code: 'EADDRINUSE' });
  const msg = listenFailureMessage(err, '127.0.0.1', 8787);
  assert.match(msg, /端口 127\.0\.0\.1:8787 已被占用/);
  assert.doesNotMatch(msg, /at |Error:/);
  assert.match(listenFailureMessage(Object.assign(new Error('x'), { code: 'EACCES' }), '0.0.0.0', 80), /没有权限/);
});
