/**
 * F31 集成故障注入与恢复演练：真实 buildServer + 假飞书 SDK + 临时 dataDir（connector-fixture.mjs）。
 * 每个中断点都在同一 dataDir 上重启验证：不自动重发可能已送达的消息、损坏即拒绝外传、
 * 终态/权限检查不可绕过、恢复完成前不受理入站事件、备份/恢复演练不重发已送达分片。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { makeFixture, scriptedSdk } from './connector-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(t, opts) {
  const fx = await makeFixture(opts);
  t.after(() => fx.dispose());
  await fx.connector();
  return fx;
}
const retry = (fx, jobId, targetId, acceptDuplicateRisk = false) => fx.call('POST', `/api/v1/jobs/${jobId}/deliveries/retry`, { connectorId: 'c1', targetId, acceptDuplicateRisk });

test('F31 中断点①：发送意图已记、平台未回（hang）→ 重启收敛 unknown，不自动重发；重试须接受重复风险', async (t) => {
  let hang = true;
  const sdk = scriptedSdk({ create: (_r, n) => (hang ? new Promise(() => {}) : { code: 0, data: { message_id: `om_${n}` } }) });
  const fx = await setup(t, { sdk, transportTimeoutMs: 60_000 });
  const job = (await fx.dispatch(['g1'], 'req_rec_0001')).json.job;
  await fx.waitParts(job.id, (i) => i[0].state === 'sending');
  await fx.restart();
  hang = false;
  const [p] = await fx.waitParts(job.id, (i) => i[0].state === 'unknown');
  assert.equal(p.error, 'RESTART_WHILE_SENDING');
  await sleep(100);
  assert.equal(sdk.calls.create.length, 1, '重启不得自动重发');
  assert.equal((await retry(fx, job.id, 'g1')).json.code, 'DUPLICATE_RISK');
  assert.equal(sdk.calls.create.length, 1);
  assert.equal((await retry(fx, job.id, 'g1', true)).status < 300, true);
  await fx.waitParts(job.id, (i) => i[0].state === 'sent');
  assert.equal(sdk.calls.create.length, 2);
  assert.notEqual(sdk.calls.create[1].uuid, undefined, '重发带幂等 uuid');
});

test('F31 中断点②：SDK 迟到成功（超过传输超时）→ 记 unknown 而非 failed；不自动重发', async (t) => {
  const sdk = scriptedSdk({ create: async (_r, n) => { await sleep(150); return { code: 0, data: { message_id: `om_${n}` } }; } });
  const fx = await setup(t, { sdk, transportTimeoutMs: 30 });
  const job = (await fx.dispatch(['g1'], 'req_rec_0002')).json.job;
  const [p] = await fx.waitParts(job.id, (i) => i[0].state === 'unknown');
  assert.equal(p.state, 'unknown');
  await sleep(300);
  assert.equal(sdk.calls.create.length, 1, '迟到成功后不应再发');
  await fx.restart();
  await sleep(100);
  assert.equal((await fx.deliveries(job.id))[0].state, 'unknown', '重启后仍为 unknown（可能已送达）');
  assert.equal(sdk.calls.create.length, 1);
});

test('F31 中断点③：平台已成功、messageId 落账写到一半（尾部半行）→ 视为未落账：unknown，不重发', async (t) => {
  const fx = await setup(t);
  const job = (await fx.dispatch(['g1'], 'req_rec_0003')).json.job;
  await fx.waitParts(job.id, (i) => i[0].state === 'sent');
  await fx.stop();
  const f = fx.file('deliveries.jsonl');
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.trimEnd().split('\n');
  assert.match(lines.at(-1), /"state":"sent"/);
  fs.writeFileSync(f, [...lines.slice(0, -1), lines.at(-1).slice(0, 25)].join('\n')); // 最后一行无换行 = 写入中断
  await fx.start();
  const [p] = await fx.waitParts(job.id, (i) => i[0].state === 'unknown');
  assert.equal(p.error, 'RESTART_WHILE_SENDING');
  assert.equal(fx.sdk.calls.create.length, 1, '可能已送达的分片不自动重发');
});

test('F31 损坏拒绝外传：账本完整行损坏 → 文件保持原样，重试/新派发都不调用 SDK', async (t) => {
  const fx = await setup(t);
  const job = (await fx.dispatch(['g1'], 'req_rec_0004')).json.job;
  await fx.waitParts(job.id, (i) => i[0].state === 'sent');
  await fx.stop();
  const f = fx.file('deliveries.jsonl');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines[0] = '{"t":"part", broken';
  const damaged = lines.join('\n');
  fs.writeFileSync(f, damaged);
  await fx.start();
  await retry(fx, job.id, 'g1', true);
  const r = await fx.dispatch(['g2'], 'req_rec_0005');
  assert.equal(r.status, 201, '确认本身可受理（记录完好）');
  await sleep(200);
  assert.equal(fx.sdk.calls.create.length, 1, '账本损坏时零外传');
  assert.deepEqual(await fx.deliveries(r.json.job.id), [], '损坏时不新建分片');
  await fx.stop();
  assert.equal(fs.readFileSync(f, 'utf8'), damaged, '损坏文件不被改写');
});

test('F31 损坏拒绝外传：确认记录完整行损坏 → 确认/追加 503 STORE_CORRUPT；尾部半行仍视为未发生', async (t) => {
  const fx = await setup(t);
  await fx.dispatch(['g1'], 'req_rec_0006');
  await fx.stop();
  const f = fx.file('delivery-confirmations.jsonl');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, good + '{"t":"accepted","requestId":"req_half');
  await fx.start();
  assert.equal((await fx.dispatch(['g2'], 'req_rec_0007')).status, 201, '尾部半行不算损坏');
  await fx.stop();
  fs.writeFileSync(f, 'not json\n' + fs.readFileSync(f, 'utf8'));
  await fx.start();
  const r = await fx.dispatch(['g2'], 'req_rec_0008');
  assert.equal(r.status, 503); assert.equal(r.json.code, 'STORE_CORRUPT');
});

test('F31 权限/终态不可绕过：重启后停用实例 → 重试不调用 SDK；已送达目标不可重试', async (t) => {
  const sdk = scriptedSdk({ create: (r, n) => (r.receiveId === 'oc_g2' ? { code: 230002, msg: 'bot not in chat' } : { code: 0, data: { message_id: `om_${n}` } }) });
  const fx = await setup(t, { sdk });
  const job = (await fx.dispatch(['g1', 'g2'], 'req_rec_0009')).json.job;
  await fx.waitParts(job.id, (i) => i.find((p) => p.targetId === 'g1')?.state === 'sent' && i.find((p) => p.targetId === 'g2')?.state === 'failed');
  await fx.restart();
  const before = sdk.calls.create.length;
  assert.equal((await retry(fx, job.id, 'g1', true)).json.code, 'NOTHING_TO_RETRY', 'sent 是终态');
  const rev = (await fx.call('GET', '/api/v1/connectors')).json.revision;
  assert.ok((await fx.call('PATCH', '/api/v1/connectors/c1', { expectedRevision: rev, patch: { enabled: false } })).status < 300);
  await retry(fx, job.id, 'g2');
  await sleep(200);
  assert.equal(sdk.calls.create.length, before, '停用后重试不得外传');
  const g2 = (await fx.deliveries(job.id)).find((p) => p.targetId === 'g2');
  assert.equal(g2.state, 'failed');
});

test('F31 先对账再开接收：长连接在恢复前收到的卡片动作被拒绝，不落动作日志、不回写', async (t) => {
  const sdk = scriptedSdk();
  const fx = await setup(t, { sdk });
  await fx.dispatch(['g1'], 'req_rec_0010');
  const early = [];
  sdk.state.onStart = async (h) => {
    early.push(await h.cardAction({ app_id: 'cli_fixture', tenant_key: 'tk1', event_id: 'ev_early', operator: { open_id: 'ou_a', tenant_key: 'tk1' }, context: { open_chat_id: 'oc_g1', open_message_id: 'om_1' }, action: { value: { sessionId: 'sess_x', actionId: 'submit' }, form_value: { stars: '5' } } }));
  };
  await fx.restart();
  assert.equal(early.length, 1);
  assert.ok(!fs.existsSync(fx.file('feishu/actions.jsonl')) || !fs.readFileSync(fx.file('feishu/actions.jsonl'), 'utf8').includes('sess_x'), '恢复前的事件不得受理');
  assert.equal(sdk.calls.patch.length, 0);
});

test('F31 备份/恢复演练：临时 dataDir 备份 → 继续派发 → 恢复备份 → 已送达不重发、后来的任务不存在', async (t) => {
  const fx = await setup(t);
  const j1 = (await fx.dispatch(['g1'], 'req_rec_0011')).json.job;
  await fx.waitParts(j1.id, (i) => i[0].state === 'sent');
  await fx.stop();
  const backup = `${fx.dataDir}.bak`;
  fs.cpSync(fx.dataDir, backup, { recursive: true });
  t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
  await fx.start();
  const j2 = (await fx.dispatch(['g2'], 'req_rec_0012')).json.job;
  await fx.waitParts(j2.id, (i) => i[0].state === 'sent');
  await fx.stop();
  fs.rmSync(fx.dataDir, { recursive: true, force: true });
  fs.cpSync(backup, fx.dataDir, { recursive: true });
  const sends = fx.sdk.calls.create.length;
  await fx.start();
  await sleep(200);
  assert.equal((await fx.deliveries(j1.id))[0].state, 'sent');
  // 任务库存放在照片库侧（不在 dataDir），恢复 dataDir 只回滚连接器账本：j2 的投递记录回到"不存在"，且不会被自动补发
  assert.deepEqual(await fx.deliveries(j2.id), [], '恢复点之后的投递记录不存在');
  assert.equal(fx.sdk.calls.create.length, sends, '恢复后零重发');
  // 同一 requestId 在恢复后重放 → 只能重建同一个确认（记录里没有它则新建），不会对 j1 重发
  const again = await fx.dispatch(['g1'], 'req_rec_0011');
  assert.equal(again.status, 409, '恢复点内已有的 requestId 换了新预览 → REQUEST_ID_CONFLICT，不会重复外传');
});
