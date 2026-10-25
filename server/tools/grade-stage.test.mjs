import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeFixture } from './connector-fixture.mjs';

const sharp = createRequire(import.meta.url)('sharp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function running(fx, params = { look: 'mono400' }) {
  const r = await fx.call('POST', '/api/v1/jobs', { kind: 'grade', selection: {}, params, mode: 'apply' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (let i = 0; i < 100; i++) {
    const j = (await fx.call('GET', `/api/v1/jobs/${r.json.id}`)).json;
    if (j.state === 'running') return j;
    await sleep(10);
  }
  throw new Error('任务没进 running');
}

test('looks：列表与 .cube', async () => {
  const fx = await makeFixture({ photos: 0 });
  try {
    const list = await fx.call('GET', '/api/v1/looks');
    assert.equal(list.json.items.length, 7);
    assert.match(list.json.license, /CC BY-SA 4\.0/);
    const r = await fx.app.inject({ method: 'GET', url: '/api/v1/looks/portrait400.cube', headers: { host: 'ff.local', origin: 'http://ff.local', cookie: '' } });
    assert.ok([200, 401].includes(r.statusCode)); // 未登录被认证门拦下也算对
    const authed = await fx.call('GET', '/api/v1/looks/nope.cube');
    assert.equal(authed.status, 404);
  } finally { await fx.dispose(); }
});

test('grade：参数校验', async () => {
  const fx = await makeFixture({ photos: 1 });
  try {
    const bad = await fx.call('POST', '/api/v1/jobs', { kind: 'grade', selection: {}, params: { look: 'gold200' }, mode: 'plan' });
    assert.equal(bad.status, 400);
    const strength = await fx.call('POST', '/api/v1/jobs', { kind: 'grade', selection: {}, params: { look: 'mono400', strength: 2 }, mode: 'plan' });
    assert.equal(strength.status, 400);
    const plan = await fx.call('POST', '/api/v1/jobs', { kind: 'grade', selection: {}, params: { look: 'mono400' }, mode: 'plan' });
    assert.equal(plan.status, 201);
    assert.equal(plan.json.items.length, 1);
  } finally { await fx.dispose(); }
});

test('grade：逐张覆盖、过目、完成后导出到数据目录，原片不动', async () => {
  const fx = await makeFixture({ photos: 2 });
  try {
    const job = await running(fx);
    const [a, b] = job.items;
    const before = fs.readdirSync(path.join(fx.dir, 'lib')).map((f) => fs.readFileSync(path.join(fx.dir, 'lib', f)).length);

    let r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: a.id, look: 'vivid100', strength: 0.5 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.state, 'running');
    assert.equal(r.json.items[0].grade.look, 'vivid100');
    assert.ok(r.json.items[0].grade.reviewedAt);
    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: b.id, look: null });
    assert.equal(r.json.items[1].grade.look, null);
    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: 'nope', look: null });
    assert.equal(r.status, 400);
    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: a.id, strength: 3 });
    assert.equal(r.status, 400);
    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/defaults`, { look: 'chrome64' });
    assert.equal(r.json.params.look, 'chrome64');
    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/explode`, {});
    assert.equal(r.status, 400);

    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/complete`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.state, 'done');
    assert.deepEqual(r.json.items.map((i) => i.status), ['done', 'done']);
    const dir = r.json.artifacts.find((x) => x.kind === 'dir').path;
    assert.equal(dir, path.join(fx.dataDir, 'exports', job.id));
    assert.deepEqual(fs.readdirSync(dir).sort(), [r.json.items[0].to, r.json.items[1].to].sort());
    assert.match(r.json.items[0].to, /_vivid100\.jpg$/);
    assert.doesNotMatch(r.json.items[1].to, /_/);
    const meta = await sharp(path.join(dir, r.json.items[0].to)).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 40);
    const after = fs.readdirSync(path.join(fx.dir, 'lib')).map((f) => fs.readFileSync(path.join(fx.dir, 'lib', f)).length);
    assert.deepEqual(after, before);

    r = await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: a.id, look: null });
    assert.equal(r.status, 409);
  } finally { await fx.dispose(); }
});

test('grade：mono 风格真的去色，强度 0 等于原图', async () => {
  const fx = await makeFixture({ photos: 2 });
  try {
    const job = await running(fx);
    await fx.call('POST', `/api/v1/jobs/${job.id}/actions/set`, { photoId: job.items[1].id, strength: 0 });
    const done = (await fx.call('POST', `/api/v1/jobs/${job.id}/actions/complete`, {})).json;
    const dir = path.join(fx.dataDir, 'exports', job.id);
    const stats = async (f) => (await sharp(path.join(dir, f)).stats()).channels.map((c) => c.mean);
    const [r, g, b] = await stats(done.items[0].to);
    assert.ok(Math.abs(r - b) < 4 && Math.abs(r - g) < 4, `mono：${r} ${g} ${b}`);
    const [r1, , b1] = await stats(done.items[1].to);
    assert.ok(b1 - r1 > 50, `原色应偏蓝：${r1} ${b1}`);
  } finally { await fx.dispose(); }
});
