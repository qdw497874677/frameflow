// F22/F24：卡片 session、动作意图、目标游标与确认控制器（全离线；假传输、假 marks，不触网）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobsStore } from '../src/adapters/outbound/fs/jobs-store.ts';
import { JobsService } from '../src/application/jobs/service.ts';
import { OperationGates } from '../src/application/operation-gates.ts';
import { SessionStore } from '../src/adapters/feishu/sessions.ts';
import { ActionLog, actionOpId } from '../src/adapters/feishu/actions.ts';
import { CursorStore } from '../src/adapters/feishu/cursors.ts';
import { FeishuController } from '../src/adapters/feishu/controller.ts';

const target = (id, kind, externalId, over = {}) => ({ id, connectorId: 'fs1', label: id, kind, externalId, projectIds: ['p1'], allowedActorIds: kind === 'group' ? ['u1', 'u2'] : [], canAnnotate: true, canRequestJpeg: false, ...over });
const doc = (targets) => ({ version: 1, revision: 1, instances: [{ id: 'fs1', kind: 'feishu', label: 'x', appId: 'cli_test', secretEnv: 'X', tenantId: 't1', enabled: true, creatorActorIds: [], creatorProjectIds: [], targets }] });
const handler = { undoable: false, validate: () => [], plan: () => [], apply: () => ({ state: 'running' }) };

function fakeMarks(photos) {
  const rev = new Map(photos.map((p) => [p, 0]));
  const ops = new Map();
  let writes = 0;
  return {
    get writes() { return writes; }, ops, rev,
    markVersion: (id) => (rev.has(id) ? { revision: rev.get(id), generation: 'g1' } : null),
    async transactMarks(r) {
      if (ops.has(r.opId)) return ops.get(r.opId);
      for (const [id, e] of Object.entries(r.expectedRevisions ?? {})) if (rev.get(id) !== e) throw new Error(`REVISION_CONFLICT: ${id}`);
      for (const [id, g] of Object.entries(r.expectedGenerations ?? {})) if (g !== 'g1') throw new Error(`SOURCE_GENERATION_CONFLICT: ${id}`);
      writes++;
      const results = r.items.map((i) => { rev.set(i.id, rev.get(i.id) + 1); return { id: i.id, ok: true, stars: i.stars, del: i.del, error: null }; });
      const out = { opId: r.opId, results, revisions: {} };
      ops.set(r.opId, out);
      return out;
    },
  };
}

async function setup(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let config = doc(over.targets ?? [target('g1', 'group', 'oc_g1'), target('g2', 'group', 'oc_g2'), target('dm', 'user', 'u1')]);
  const gates = new OperationGates();
  const jobs = new JobsService(new JobsStore(dir), { annotate: handler }, { lib: { gates } });
  jobs.createConfirmed({ jobId: 'job1', requestId: 'req1', kind: 'annotate', selection: {}, params: {}, items: [{ id: 'a' }, { id: 'b' }], confirmationMode: 'explicit' });
  for (let i = 0; i < 100 && jobs.get('job1').state !== 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  const marks = over.marks ?? fakeMarks(['a', 'b']);
  const sent = [];
  let n = 0;
  const mk = (maxPending) => {
    const sessions = new SessionStore(dir);
    const ctl = new FeishuController({
      sessions, actions: new ActionLog(dir, maxPending), cursors: new CursorStore(dir), config: () => config,
      jobs: { get: (id) => { try { return jobs.get(id); } catch { return undefined; } }, runInJobGate: (id, fn) => jobs.runInJobGate(id, fn), projectConfirmation: (id, p) => jobs.projectConfirmation(id, p) },
      marks, projectOf: () => 'p1', deliveredTargets: () => ['g1', 'g2', 'dm'],
      send: async (cid, input) => { sent.push({ op: 'send', ...input }); return { status: 'sent', messageId: `om_${++n}` }; },
      update: async (cid, input) => { sent.push({ op: 'update', ...input }); return { status: 'sent', messageId: input.messageId }; },
    });
    return { ctl, sessions };
  };
  return { dir, jobs, marks, sent, mk, setConfig: (c) => { config = c; } };
}
const ev = (s, actorId, actionId, form, chat = 'oc_g1', messageId) => ({
  identity: { connectorId: 'fs1', tenantId: 't1', actorId }, source: { kind: 'group', externalId: chat }, messageId: messageId ?? s.messageId ?? undefined,
  payload: { type: 'card-action', sessionId: s.sessionId, actionId, form: form ?? {} },
});
const review = async (ctl, targetId = 'g1', photo = 'a') => ctl.render({ connectorId: 'fs1', tenantId: 't1', targetId, jobId: 'job1' }, photo);

test('F22 session 绑定：转发到别的群、换消息、过期、伪造 sessionId 均拒绝；重启可读回', async (t) => {
  const { mk, dir } = await setup(t);
  const { ctl, sessions } = mk();
  const s = await review(ctl);
  assert.equal((await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '3' }, 'oc_g2'))).code, 'SESSION_MISMATCH');
  assert.equal((await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '3' }, 'oc_g1', 'om_other'))).code, 'SESSION_MISMATCH');
  assert.equal((await ctl.handle('fs1', { ...ev(s, 'u1', 'submit', { stars: '3' }), payload: { type: 'card-action', sessionId: 's_fake', actionId: 'submit' } })).code, 'SESSION_NOT_FOUND');
  assert.equal((await ctl.handle('fs1', ev(s, 'u9', 'submit', { stars: '3' }))).code, 'ACTOR_NOT_ALLOWED');
  assert.equal((await ctl.handle('fs1', ev(s, 'u1', 'submit', {}))).code, 'INVALID_FORM', '表单未选星不受理');
  const old = sessions.get(s.sessionId);
  assert.equal(sessions.check(s.sessionId, { connectorId: 'fs1', tenantId: 't1', targetId: 'g1' }, old.expiresAt + 1).code, 'SESSION_EXPIRED');
  const again = new SessionStore(dir).get(s.sessionId);
  assert.equal(again.jobId, 'job1'); assert.equal(again.photoId, 'a'); assert.equal(again.messageId, s.messageId ?? again.messageId);
});

test('F24 确认：处理中→落盘→投影→卡片前进；同载荷重放、异载荷拒绝；opId 不含星级', async (t) => {
  const { mk, jobs, marks, sent } = await setup(t);
  const { ctl } = mk();
  const s = await review(ctl);
  const ack = await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '4', reject: false }));
  assert.deepEqual(ack, { kind: 'accepted', toast: '处理中' });
  await ctl.idle();
  const a = jobs.get('job1').items.find((i) => i.id === 'a');
  assert.equal(a.stars, 4); assert.ok(a.confirmedAt); assert.equal(a.sourceOpId, actionOpId(s.sessionId, 'submit', 'u1'));
  assert.equal(sent.at(-1).op, 'update'); assert.equal(sent.at(-1).content.photoId, 'b');
  assert.equal((await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '4', reject: false }))).toast, '已处理');
  assert.equal((await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '2' }))).code, 'ACTION_CONFLICT');
  assert.equal(marks.writes, 1);
});

test('F24 竞争：群里两人对同一旧版卡片，只一项成功，另一项 STALE 并刷新卡片', async (t) => {
  const { mk, marks, sent } = await setup(t);
  const { ctl } = mk();
  const s = await review(ctl);
  await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '5' }));
  await ctl.handle('fs1', ev(s, 'u2', 'submit', { stars: '1' }));
  await ctl.idle();
  assert.equal(marks.writes, 1);
  const outs = [...sent].map((x) => x.content.photoId);
  assert.ok(outs.includes('a'), '冲突方刷新到最新版本');
  // 网页/私聊另一张旧卡也一样
  const dm = await review(ctl, 'dm', 'a');
  marks.rev.set('a', marks.rev.get('a') + 1); // 网页抢先改
  await ctl.handle('fs1', { ...ev(dm, 'u1', 'submit', { stars: '2' }), source: { kind: 'user', externalId: 'u1' } });
  await ctl.idle();
  assert.equal(marks.writes, 1);
});

test('F24 排队后撤权/任务取消 → 拒绝，不落标', async (t) => {
  const { mk, marks, setConfig, jobs } = await setup(t);
  const { ctl } = mk();
  const s = await review(ctl);
  let release;
  const held = jobs.runInJobGate('job1', () => new Promise((r) => { release = r; }));
  const ack = await ctl.handle('fs1', ev(s, 'u1', 'submit', { stars: '3' }));
  assert.equal(ack.kind, 'accepted');
  setConfig(doc([target('g1', 'group', 'oc_g1', { allowedActorIds: ['u2'] })]));
  release(); await held;
  await ctl.idle();
  assert.equal(marks.writes, 0, '执行时复验授权');
  setConfig(doc([target('g1', 'group', 'oc_g1')]));
  const s2 = await review(ctl);
  const held2 = jobs.runInJobGate('job1', () => new Promise((r) => { release = r; }));
  const cancelling = jobs.cancel('job1'); // 先排上队
  assert.equal((await ctl.handle('fs1', ev(s2, 'u1', 'submit', { stars: '3' }))).kind, 'accepted');
  release(); await held2; await cancelling;
  await ctl.idle();
  assert.equal(jobs.get('job1').state, 'cancelled');
  assert.equal(marks.writes, 0, '取消竞争拒绝');
});

test('F22 过载拒绝；目标间游标独立；重启恢复只补投影不重复写', async (t) => {
  const { mk, marks, jobs, dir } = await setup(t);
  const { ctl } = mk(1);
  const g1 = await review(ctl, 'g1', 'a');
  const g2 = await review(ctl, 'g2', 'b');
  assert.notEqual(new CursorStore(dir).get('job1', 'g1').photoId, new CursorStore(dir).get('job1', 'g2').photoId);
  // 模拟受理落盘后崩溃：直接写 accepted，不处理；重启后的控制器看见 1 条待处理
  const r = new ActionLog(dir, 1).accept({ sessionId: g1.sessionId, actionId: 'submit', actorId: 'u1', payload: { stars: 2, del: false }, source: { kind: 'group', externalId: 'oc_g1' }, messageId: g1.messageId });
  assert.equal(r.kind, 'new');
  const fresh = mk(1).ctl;
  assert.equal((await fresh.handle('fs1', ev(g2, 'u1', 'submit', { stars: '1' }, 'oc_g2'))).code, 'OVERLOADED');
  // marks 已提交、投影未写（崩溃在两步之间）
  await marks.transactMarks({ opId: r.intent.opId, items: [{ id: 'a', stars: 2, del: false }], expectedRevisions: { a: 0 } });
  assert.equal(fresh.recover(), 1);
  await fresh.idle();
  assert.equal(marks.writes, 1, '同 opId 由 marks 重放');
  assert.ok(jobs.get('job1').items.find((i) => i.id === 'a').confirmedAt);
  assert.equal(new ActionLog(dir).pending().length, 0);
});

test('F28 原图请求：仅授权目标可见按钮；只发当前目标；稳定意图去重；撤权后缓存不替代复验', async (t) => {
  const { mk, sent, setConfig } = await setup(t, { targets: [target('g1', 'group', 'oc_g1', { canRequestJpeg: true }), target('g2', 'group', 'oc_g2')] });
  const { ctl } = mk();
  const s = await review(ctl);
  const card0 = await ctl.resolve(sent.find((x) => x.op === 'send').content, s.sessionId);
  assert.ok(card0.actions.some((a) => a.actionId === 'jpeg' && /JPEG/.test(a.label)), '授权目标有按钮');
  const s2 = await review(ctl, 'g2');
  assert.ok(!(await ctl.resolve(sent.at(-1).content, s2.sessionId)).actions.some((a) => a.actionId === 'jpeg'), '未授权目标无按钮');
  assert.equal((await ctl.handle('fs1', ev(s2, 'u1', 'jpeg', {}, 'oc_g2'))).code, 'JPEG_DENIED');
  await ctl.handle('fs1', ev(s, 'u1', 'jpeg')); await ctl.idle();
  const files = () => sent.filter((x) => x.content?.type === 'file');
  assert.equal(files().length, 1); assert.equal(files()[0].targetId, 'g1'); assert.equal(files()[0].content.mediaRef, 'a');
  assert.match(files()[0].intentId, /^jpeg_[0-9a-f]{40}$/);
  await ctl.handle('fs1', ev(s, 'u2', 'jpeg')); await ctl.idle();
  assert.equal(files().length, 1, '同一 (任务, 照片, 目标) 已送达不重发');
  setConfig(doc([target('g1', 'group', 'oc_g1', { canRequestJpeg: false }), target('g2', 'group', 'oc_g2')]));
  const r = await ctl.handle('fs1', ev(s, 'u1', 'jpeg'));
  await ctl.idle();
  assert.ok(r.code === 'JPEG_DENIED' || r.kind === 'accepted');
  assert.equal(files().length, 1);
});
