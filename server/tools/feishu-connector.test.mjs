// F19/F20：飞书传输端口（假 SDK，零网络、零真实 WS）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuTransport } from '../src/connectors/feishu/transport.ts';
import { mapCardAction, mapMessage } from '../src/connectors/feishu/events.ts';
import { SANITIZED_LOGGER } from '../src/connectors/feishu/client.ts';
import { updateAllowed, CARD_UPDATE_WINDOW_MS, renderCard } from '../src/connectors/feishu/cards.ts';

const inst = {
  id: 'c1', kind: 'feishu', label: '飞书', appId: 'cli_a', secretEnv: 'X', tenantId: 'tk1', enabled: true,
  targets: [
    { id: 'g1', connectorId: 'c1', label: '群', kind: 'group', externalId: 'oc_g1', projectIds: ['p'], allowedActorIds: ['ou_a'], canAnnotate: true, canRequestJpeg: false },
    { id: 'u1', connectorId: 'c1', label: '私聊', kind: 'user', externalId: 'ou_b', projectIds: ['p'], allowedActorIds: [], canAnnotate: true, canRequestJpeg: false },
  ],
  creatorActorIds: [], creatorProjectIds: [],
};

function fakeSdk(over = {}) {
  const calls = { create: [], patch: [], upload: [], verify: 0, wsStart: 0, wsClose: 0, apiNew: 0, wsNew: 0 };
  let handlers = null;
  const sdk = {
    api(appId, secret) {
      calls.apiNew++; calls.secret = secret;
      return {
        createMessage: async (r) => { calls.create.push(r); return over.create ? over.create(r, calls) : { code: 0, data: { message_id: `om_${calls.create.length}` } }; },
        patchMessage: async (r) => { calls.patch.push(r); return over.patch ? over.patch(r) : { code: 0 }; },
        uploadImage: async (b) => { calls.upload.push(b); return { code: 0, data: { image_key: `img_${calls.upload.length}` } }; },
        uploadFile: async (r) => { (calls.files ??= []).push(r); return over.uploadFile ? over.uploadFile(r) : { code: 0, data: { file_key: 'f' } }; },
        verifyToken: async () => { calls.verify++; return over.verify ? over.verify() : { code: 0 }; },
      };
    },
    longConnection() {
      calls.wsNew++;
      return { start: async (h) => { calls.wsStart++; handlers = h; if (over.wsFail) throw new Error('x'); }, close: () => { calls.wsClose++; } };
    },
  };
  return { sdk, calls, handlers: () => handlers };
}

const card = (over = {}) => ({ app_id: 'cli_a', tenant_key: 'tk1', event_id: 'ev1', operator: { open_id: 'ou_a', tenant_key: 'tk1' }, context: { open_chat_id: 'oc_g1', open_message_id: 'om_1' }, action: { value: { sessionId: 's1', actionId: 'submit', photoId: 'leak' }, form_value: { stars: '4', reject: false, '<bad>': 1 } }, ...over });

test('F19 事件映射：可信租户/用户/目标，缺上下文拒绝，仅取不透明字段', () => {
  const r = mapCardAction(card(), inst);
  assert.ok(r.ok);
  assert.deepEqual(r.event.identity, { connectorId: 'c1', tenantId: 'tk1', actorId: 'ou_a' });
  assert.deepEqual(r.event.source, { kind: 'group', externalId: 'oc_g1' });
  assert.deepEqual(r.event.payload, { type: 'card-action', sessionId: 's1', actionId: 'submit', form: { stars: '4', reject: false } });
  assert.equal(mapCardAction(card({ app_id: 'cli_other' }), inst).code, 'APP_MISMATCH');
  assert.equal(mapCardAction(card({ tenant_key: 'tk2' }), inst).code, 'TENANT_MISMATCH');
  assert.equal(mapCardAction(card({ operator: {} }), inst).code, 'ACTOR_MISSING');
  assert.equal(mapCardAction(card({ action: {} }), inst).code, 'ACTION_VALUE_MISSING');
  assert.equal(mapCardAction(card(), { ...inst, tenantId: null }).code, 'TENANT_UNBOUND');
  assert.equal(mapCardAction(card({ context: {} }), inst).event.source, null, '无会话上下文 → source=null（授权拒绝）');
  const p2p = mapCardAction(card({ operator: { open_id: 'ou_b' }, context: { open_chat_id: 'oc_p2p' } }), inst);
  assert.deepEqual(p2p.event.source, { kind: 'user', externalId: 'ou_b' });
  const m = mapMessage({ app_id: 'cli_a', tenant_key: 'tk1', sender: { sender_id: { open_id: 'ou_b' }, sender_type: 'user' }, message: { chat_id: 'oc_p', chat_type: 'p2p', message_id: 'om_9', message_type: 'text', content: '{"text":"任务"}' } }, inst);
  assert.deepEqual(m.event.source, { kind: 'user', externalId: 'ou_b' });
  assert.equal(m.event.payload.text, '任务');
  assert.equal(mapMessage({ app_id: 'cli_a', tenant_key: 'tk1', sender: { sender_id: { open_id: 'ou_b' } }, message: { chat_id: 'oc_p' } }, inst).code, 'CONTEXT_MISSING');
  assert.equal(mapMessage({ app_id: 'cli_a', tenant_key: 'tk1', sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'app' }, message: { chat_id: 'oc_p', chat_type: 'group' } }, inst).code, 'NOT_A_USER');
});

test('F19 生命周期：每实例一个 API + 一个长连接，状态区分出站与长连接；净化日志', async () => {
  const f = fakeSdk();
  const t = new FeishuTransport({ instance: inst, secret: 'sek', sdk: f.sdk });
  assert.equal(f.calls.wsNew, 0, '构造不建长连接');
  assert.deepEqual(t.health(), { outbound: 'unknown', longConnection: 'stopped' });
  await t.start(async () => ({ kind: 'accepted' }));
  assert.equal(f.calls.wsNew, 1); assert.equal(f.calls.wsStart, 1); assert.equal(f.calls.apiNew, 1);
  assert.equal(t.health().longConnection, 'started');
  assert.deepEqual(await t.verify(), { ok: true });
  assert.equal(t.health().outbound, 'ok');
  await t.stop();
  assert.equal(f.calls.wsClose, 1); assert.equal(t.health().longConnection, 'stopped');
  const bad = fakeSdk({ wsFail: true, verify: () => ({ code: 10014, msg: 'app secret invalid sek' }) });
  const t2 = new FeishuTransport({ instance: inst, secret: 'sek', sdk: bad.sdk });
  await assert.rejects(t2.start(async () => ({ kind: 'accepted' })));
  assert.equal(t2.health().longConnection, 'error'); assert.equal(bad.calls.wsClose, 1);
  assert.deepEqual(await t2.verify(), { ok: false, code: 'FEISHU_10014' });
  // 净化 logger 不输出参数
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try { SANITIZED_LOGGER.error({ headers: { Authorization: 'Bearer t-secret' } }, 'sek'); } finally { console.error = orig; }
  assert.ok(seen.length === 1 && !seen[0].includes('secret') && !seen[0].includes('sek'));
});

test('F19 回调有界受理：慢处理先回已受理（<3s），后台继续；拒绝带错误 toast', async () => {
  const f = fakeSdk();
  const t = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk, ackBudgetMs: 30 });
  let release; let done = false; const events = [];
  await t.start(async (e) => { events.push(e); await new Promise((r) => { release = r; }); done = true; return { kind: 'accepted', toast: '完成' }; });
  const t0 = Date.now();
  const res = await f.handlers().cardAction(card());
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(res, { toast: { type: 'success', content: '已收到，正在处理' } });
  assert.equal(t.background.size, 1); release(); await Promise.all([...t.background]); assert.ok(done);
  const rej = await f.handlers().cardAction(card({ tenant_key: 'evil' }));
  assert.equal(rej.toast.type, 'error'); assert.equal(events.length, 1, '不可信事件不进业务');
  const t3 = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk });
  await t3.start(async () => { throw new Error('boom'); });
  assert.equal((await f.handlers().cardAction(card())).toast.type, 'error');
});

test('F19 发送：chat_id/open_id 映射、uuid=intent、频控/业务码/传输异常/超时+迟到成功', async () => {
  const f = fakeSdk();
  const t = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk });
  assert.deepEqual(await t.send({ targetId: 'g1', intentId: 'i1', content: { type: 'test-card' } }), { status: 'sent', messageId: 'om_1' });
  assert.deepEqual(await t.send({ targetId: 'u1', intentId: 'i2', content: { type: 'task-entry', taskId: 'j' }, sessionId: 's9' }), { status: 'sent', messageId: 'om_2' });
  assert.deepEqual(f.calls.create.map((c) => [c.receiveIdType, c.receiveId, c.uuid, c.msgType]), [['chat_id', 'oc_g1', 'i1', 'interactive'], ['open_id', 'ou_b', 'i2', 'interactive']]);
  assert.ok(JSON.parse(f.calls.create[1].content).body.elements.some((e) => e.behaviors?.[0].value.sessionId === 's9'));
  assert.deepEqual(await t.send({ targetId: 'zz', intentId: 'i3', content: { type: 'test-card' } }), { status: 'failed', code: 'TARGET_REVOKED', retryable: false });
  assert.equal(f.calls.create.length, 2);
  let mode = 'rate';
  let late;
  const g = fakeSdk({ create: () => mode === 'rate' ? { code: 99991400 } : mode === 'biz' ? { code: 230002 } : mode === 'throw' ? Promise.reject(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })) : new Promise((r) => { late = r; }) });
  const lates = [];
  const t2 = new FeishuTransport({ instance: inst, secret: 's', sdk: g.sdk, timeoutMs: 20, onLate: (id, r) => lates.push([id, r]) });
  const s = (id) => t2.send({ targetId: 'g1', intentId: id, content: { type: 'test-card' } });
  assert.deepEqual(await s('a'), { status: 'failed', code: 'RATE_LIMITED', retryable: true });
  mode = 'biz'; assert.deepEqual(await s('b'), { status: 'failed', code: 'FEISHU_230002', retryable: false });
  mode = 'throw'; assert.deepEqual(await s('c'), { status: 'unknown', code: 'TRANSPORT_ERROR' });
  mode = 'hang'; assert.deepEqual(await s('d'), { status: 'unknown', code: 'TIMEOUT' });
  assert.equal(g.calls.create.length, 4, '每次只调用一次，无内部重试');
  late({ code: 0, data: { message_id: 'om_late' } }); await new Promise((r) => setImmediate(r));
  assert.deepEqual(lates, [['d', { status: 'sent', messageId: 'om_late' }]], '迟到成功归原 intent');
  assert.deepEqual(await t2.send({ targetId: 'g1', intentId: 'e', content: { type: 'progress', taskId: 'j' } }), { status: 'failed', code: 'CONTENT_UNSUPPORTED', retryable: false });
});

function previewDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-media-'));
  fs.writeFileSync(path.join(dir, 'p1.jpg'), Buffer.from('JPEGBYTES-1'));
  fs.writeFileSync(path.join(dir, 'big.jpg'), Buffer.alloc(64));
  return dir;
}

test('F20 预览上传：只读 2048 预览、≤上限、按 app+源签名缓存、失效重传、无预览不回退原片', async (tc) => {
  const dir = previewDir(); tc.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sig = 'e1';
  const asked = [];
  const preview = async (id) => { asked.push(id); if (id === 'none') throw new Error('PreviewUnavailable'); return { path: path.join(dir, id === 'big' ? 'big.jpg' : 'p1.jpg'), signature: id === 'big' ? 'eb' : sig }; };
  const resolve = async (c) => c.type === 'photo-review' ? { title: '第 1 张', lines: ['1/3'], photoId: c.photoId, sessionId: 's1', reviewForm: { stars: null, reject: false } } : null;
  let invalidOnce = true;
  const f = fakeSdk({ create: (r, calls) => (invalidOnce && JSON.parse(r.content).body.elements[0].img_key === 'img_1' && calls.create.length === 3) ? (invalidOnce = false, { code: 234001 }) : { code: 0, data: { message_id: `om_${calls.create.length}` } } });
  const t = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk, preview, resolve });
  const send = (id, photoId) => t.send({ targetId: 'g1', intentId: id, content: { type: 'photo-review', taskId: 'j', photoId } });
  assert.equal((await send('i1', 'a')).status, 'sent');
  assert.equal((await send('i2', 'a')).status, 'sent');
  assert.equal(f.calls.upload.length, 1, '同 app+签名命中缓存');
  assert.deepEqual(f.calls.upload[0], Buffer.from('JPEGBYTES-1'), '上传的是预览字节');
  const body = JSON.parse(f.calls.create[0].content);
  assert.equal(body.body.elements[0].img_key, 'img_1');
  assert.ok(!f.calls.create[0].content.includes('"a"'), '卡片不暴露照片 ID');
  // 第 3 次：平台判 image_key 失效 → 重传并再发一次
  const r3 = await send('i3', 'a');
  assert.equal(r3.status, 'sent'); assert.equal(f.calls.upload.length, 2); assert.equal(f.calls.create.length, 4);
  assert.notEqual(f.calls.create[3].uuid, f.calls.create[2].uuid);
  sig = 'e2'; await send('i4', 'a'); assert.equal(f.calls.upload.length, 3, '源签名变化重传');
  const before = f.calls.create.length;
  assert.deepEqual(await send('i5', 'none'), { status: 'failed', code: 'PREVIEW_UNAVAILABLE', retryable: false });
  const small = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk, resolve, preview });
  // 超上限：用小上限的 uploader 证明拒绝（通过 MediaUploader 直接）
  const { MediaUploader } = await import('../src/connectors/feishu/media.ts');
  const mu = new MediaUploader({ api: f.sdk.api('cli_a', 's'), appId: 'cli_a', preview, maxBytes: 10 });
  await assert.rejects(mu.imageKey('big'), /PREVIEW_TOO_LARGE/);
  assert.equal(f.calls.create.length, before, '失败零发送');
  void small;
});

test('F20 卡片更新：有效期受限；更新失败只返回结果', async () => {
  const now = Date.now();
  assert.equal(updateAllowed(now - 1000, now), true);
  assert.equal(updateAllowed(now - CARD_UPDATE_WINDOW_MS, now), false);
  const f = fakeSdk({ patch: () => ({ code: 230031 }) });
  const t = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk });
  assert.deepEqual(await t.update({ targetId: 'g1', intentId: 'u', messageId: 'om_1', content: { type: 'test-card' } }), { status: 'failed', code: 'FEISHU_230031', retryable: false });
  const ok = new FeishuTransport({ instance: inst, secret: 's', sdk: fakeSdk().sdk });
  assert.deepEqual(await ok.update({ targetId: 'g1', intentId: 'u', messageId: 'om_1', content: { type: 'test-card' } }), { status: 'sent', messageId: 'om_1' });
  const c = JSON.parse(renderCard({ title: 't', lines: ['**x**'], sessionId: 's', actions: [{ label: '下一张', actionId: 'next' }] }));
  assert.equal(c.schema, '2.0'); assert.equal(c.config.update_multi, true);
  assert.equal(c.body.elements[0].content, '\\*\\*x\\*\\*');
});

test('F28 原图 JPEG：只发真实 JPEG 字节（hash 一致），RAW/伪 JPEG/空/超限/失联拒绝且不上传', async (t) => {
  const { createHash } = await import('node:crypto');
  const fsm = await import('node:fs');
  const osm = await import('node:os');
  const pm = await import('node:path');
  const dir = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'fs-jpeg-'));
  t.after(() => fsm.rmSync(dir, { recursive: true, force: true }));
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
  fsm.writeFileSync(pm.join(dir, 'A.jpg'), jpg);
  fsm.writeFileSync(pm.join(dir, 'fake.jpg'), Buffer.from('not a jpeg'));
  fsm.writeFileSync(pm.join(dir, 'empty.jpg'), Buffer.alloc(0));
  fsm.writeFileSync(pm.join(dir, 'B.ARW'), jpg);
  const files = { a: ['A.jpg', 'A.jpg'], fake: ['fake.jpg', 'fake.jpg'], empty: ['empty.jpg', 'empty.jpg'], raw: ['B.ARW', 'B.ARW'], gone: ['missing.jpg', 'missing.jpg'] };
  const original = async (id) => { const f = files[id]; if (!f) throw new Error('x'); return { path: pm.join(dir, f[0]), fileName: f[1] }; };
  const f = fakeSdk();
  const tr = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk, original });
  const r = await tr.send({ targetId: inst.targets[0].id, intentId: 'jpeg_1', content: { type: 'file', mediaRef: 'a' } });
  assert.equal(r.status, 'sent');
  assert.equal(createHash('sha256').update(f.calls.files[0].bytes).digest('hex'), createHash('sha256').update(jpg).digest('hex'), '上传字节与原片一致');
  assert.equal(f.calls.create.at(-1).msgType, 'file');
  assert.deepEqual(JSON.parse(f.calls.create.at(-1).content), { file_key: 'f' });
  for (const [id, code] of [['fake', 'JPEG_UNSUPPORTED'], ['empty', 'JPEG_UNAVAILABLE'], ['raw', 'JPEG_UNSUPPORTED'], ['gone', 'JPEG_UNAVAILABLE'], ['nope', 'JPEG_UNAVAILABLE']]) {
    const x = await tr.send({ targetId: inst.targets[0].id, intentId: `j_${id}`, content: { type: 'file', mediaRef: id } });
    assert.equal(x.code, code, id);
  }
  assert.equal(f.calls.files.length, 1, '被拒的不上传');
  const { readJpeg } = await import('../src/connectors/feishu/media.ts');
  await assert.rejects(readJpeg(pm.join(dir, 'A.jpg'), 'A.jpg', 100), /JPEG_TOO_LARGE/);
  const noOrig = new FeishuTransport({ instance: inst, secret: 's', sdk: f.sdk });
  assert.equal((await noOrig.send({ targetId: inst.targets[0].id, intentId: 'j_x', content: { type: 'file', mediaRef: 'a' } })).code, 'JPEG_UNAVAILABLE');
});
