// F25/F26：上一张/复核/列表分页/过期重开；文本命令与飞书内创建（全离线，假传输/假 marks/假确认）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobsStore } from '../src/core/jobs.ts';
import { JobsService } from '../src/jobs/service.ts';
import { OperationGates } from '../src/core/operation-gates.ts';
import { SessionStore } from '../src/integrations/feishu/sessions.ts';
import { ActionLog } from '../src/integrations/feishu/actions.ts';
import { CursorStore } from '../src/integrations/feishu/cursors.ts';
import { FeishuController } from '../src/integrations/feishu/controller.ts';
import { parseCommand } from '../src/integrations/feishu/commands.ts';

const target = (id, kind, externalId) => ({ id, connectorId: 'fs1', label: id, kind, externalId, projectIds: ['p1', 'p2'], allowedActorIds: kind === 'group' ? ['u1', 'u2'] : [], canAnnotate: true, canRequestJpeg: false });
const doc = () => ({ version: 1, revision: 1, instances: [{ id: 'fs1', kind: 'feishu', label: 'x', appId: 'cli_test', secretEnv: 'X', tenantId: 't1', enabled: true, creatorActorIds: ['u1'], creatorProjectIds: ['p1'], targets: [target('g1', 'group', 'oc_g1'), target('g2', 'group', 'oc_g2')] }] });
const handler = { undoable: false, validate: () => [], plan: () => [], apply: () => ({ state: 'running' }) };
const marks = { markVersion: (id) => ({ revision: 0, generation: 'g1' }), async transactMarks(r) { return { opId: r.opId, results: r.items.map((i) => ({ id: i.id, ok: true })), revisions: {} }; } };

async function setup(t, nJobs = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jobs = new JobsService(new JobsStore(dir), { annotate: handler }, { lib: { gates: new OperationGates() } });
  for (let k = 1; k <= nJobs; k++) jobs.createConfirmed({ jobId: `job${k}`, requestId: `req${k}`, kind: 'annotate', selection: {}, params: { label: `批次${k}` }, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], confirmationMode: 'explicit' });
  for (let i = 0; i < 200 && jobs.list().some((j) => j.state !== 'running'); i++) await new Promise((r) => setTimeout(r, 5));
  const sent = [];
  let n = 0, clock = Date.now();
  const created = [];
  const sessions = new SessionStore(dir);
  const ctl = new FeishuController({
    sessions, actions: new ActionLog(dir), cursors: new CursorStore(dir), config: doc, now: () => clock,
    jobs: { get: (id) => { try { return jobs.get(id); } catch { return undefined; } }, runInJobGate: (id, fn) => jobs.runInJobGate(id, fn), projectConfirmation: (id, p) => jobs.projectConfirmation(id, p) },
    marks, projectOf: () => 'p1', deliveredTargets: () => ['g1'],
    jobsForTarget: (_c, tid) => (tid === 'g1' ? jobs.list() : []),
    creation: {
      projectName: (p) => ({ p1: '婚礼', p2: '私密' })[p],
      preview: (projectId) => ({ ok: true, previewId: `pv_${projectId}`, revision: 'r1', photoCount: 7 }),
      confirm: async (input) => { const replayed = created.some((c) => c.requestId === input.requestId); created.push(input); return { jobId: 'jobN', replayed }; },
    },
    send: async (cid, input) => { const messageId = `om_${++n}`; sent.push({ op: 'send', ...input, messageId }); return { status: 'sent', messageId }; },
    update: async (cid, input) => { sent.push({ op: 'update', ...input }); return { status: 'sent', messageId: input.messageId }; },
  });
  return { ctl, sessions, sent, created, jobs, tick: (ms) => { clock += ms; } };
}
const msg = (text, mentioned = true, actorId = 'u1', chat = 'oc_g1') => ({ identity: { connectorId: 'fs1', tenantId: 't1', actorId }, source: { kind: 'group', externalId: chat }, messageId: `m_${Math.random()}`, payload: { type: 'message', text, mentioned } });
const click = (sessionId, messageId, actionId, actorId = 'u1', form = {}) => ({ identity: { connectorId: 'fs1', tenantId: 't1', actorId }, source: { kind: 'group', externalId: 'oc_g1' }, messageId, payload: { type: 'card-action', sessionId, actionId, form } });
const mid = (x) => x.messageId ?? `om_${x._n}`;
const last = async (ctl, sent) => { await ctl.idle(); const x = sent.at(-1); return { x, card: await ctl.resolve(x.content, x.sessionId) }; };

test('F26 命令解析：群里需 @，私聊不需要；未知命令回帮助', () => {
  assert.equal(parseCommand({ text: '任务', mentioned: false }, 'group'), null);
  assert.deepEqual(parseCommand({ text: '任务', mentioned: true }, 'group'), { name: 'list', known: true });
  assert.deepEqual(parseCommand({ text: ' /新建 ' }, 'user'), { name: 'create', known: true });
  assert.deepEqual(parseCommand({ text: '随便说点' }, 'user'), { name: 'help', known: false });
});

test('F25 列表分页只列可见任务；上一张/跳过不写标记；复核模式只走已确认并显示当前值', async (t) => {
  const { ctl, sent } = await setup(t, 7);
  assert.equal((await ctl.handle('fs1', msg('任务', false))).code, 'NOT_MENTIONED');
  assert.equal((await ctl.handle('fs1', msg('任务', true, 'u9'))).code, 'ACTOR_NOT_ALLOWED');
  assert.equal((await ctl.handle('fs1', msg('任务'))).kind, 'accepted');
  let { x, card } = await last(ctl, sent);
  assert.equal(card.actions.filter((a) => a.sessionId).length, 5, '每页 5 个');
  assert.ok(card.actions.some((a) => a.actionId === 'list-page'));
  await ctl.handle('fs1', click(x.sessionId, 'om_1', 'list-page'));
  ({ x, card } = await last(ctl, sent));
  assert.equal(x.op, 'update');
  assert.equal(card.actions.filter((a) => a.sessionId).length, 2);
  assert.ok(card.actions.some((a) => a.actionId === 'list-prev'));
  // 在别的群列不到
  await ctl.handle('fs1', msg('任务', true, 'u1', 'oc_g2'));
  ({ card } = await last(ctl, sent));
  assert.match(card.lines[0], /还没有/);
  // 打开第一项 → 照片卡；提交 a，上一张回到 a（不写），review 模式只看已确认
  const item = (await ctl.resolve({ type: 'session-card' }, sent[0].sessionId)).actions[0];
  await ctl.handle('fs1', click(item.sessionId, 'om_1', 'open'));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /第 1\/3/);
  const s1 = x.sessionId;
  await ctl.handle('fs1', click(s1, mid(x), 'submit', 'u1', { stars: '4' }));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /第 2\/3/);
  await ctl.handle('fs1', click(x.sessionId, mid(x), 'prev'));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /第 1\/3.*已确认/);
  assert.ok(card.lines.some((l) => /当前：4 星/.test(l)), 'remark 先显示当前值');
  assert.equal(card.reviewForm.stars, 4);
  await ctl.handle('fs1', click(x.sessionId, mid(x), 'review'));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /第 1\/3/);
  assert.ok(card.lines.some((l) => /复核模式/.test(l)));
  await ctl.handle('fs1', click(x.sessionId, mid(x), 'skip'));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /进度/, '复核下一张没有已确认的 → 进度卡');
});

test('F25 过期卡片：重开发新卡片并撤销旧 session；继续命令打开未完成任务', async (t) => {
  const { ctl, sent, sessions, tick } = await setup(t, 1);
  await ctl.handle('fs1', msg('继续'));
  let { x, card } = await last(ctl, sent);
  assert.match(card.title, /第 1\/3/);
  const old = x.sessionId;
  tick(15 * 24 * 3600e3);
  assert.equal((await ctl.handle('fs1', click(old, 'om_1', 'submit', 'u1', { stars: '3' }))).code, 'SESSION_EXPIRED');
  assert.equal((await ctl.handle('fs1', click(old, 'om_1', 'reopen'))).kind, 'accepted');
  ({ x } = await last(ctl, sent));
  assert.equal(x.op, 'send', '超出更新窗口，发新消息');
  assert.equal(sessions.check(old, { connectorId: 'fs1', tenantId: 't1', targetId: 'g1' }, Date.now()).code, 'SESSION_NOT_FOUND', '旧 session 已撤销');
  assert.equal((await ctl.handle('fs1', click(x.sessionId, 'om_2', 'submit', 'u1', { stars: '3' }))).kind, 'accepted');
});

test('F26 飞书内创建：只列允许项目 → 预览 → 一次确认；重复确认同 requestId 只建一次；非创建者拒绝', async (t) => {
  const { ctl, sent, created } = await setup(t, 0);
  assert.equal((await ctl.handle('fs1', msg('新建', true, 'u2'))).code, 'NOT_CREATOR');
  await ctl.handle('fs1', msg('新建'));
  let { x, card } = await last(ctl, sent);
  assert.deepEqual(card.actions.map((a) => a.label), ['婚礼'], 'p2 不在 creatorProjectIds');
  // 别人点项目按钮：非创建者
  assert.equal((await ctl.handle('fs1', click(card.actions[0].sessionId, 'om_1', 'pick', 'u2'))).code, 'NOT_CREATOR');
  // 不能拿项目按钮直接确认
  assert.equal((await ctl.handle('fs1', click(card.actions[0].sessionId, 'om_1', 'confirm-create'))).code, 'ACTION_UNKNOWN');
  await ctl.handle('fs1', click(card.actions[0].sessionId, 'om_1', 'pick'));
  ({ x, card } = await last(ctl, sent));
  assert.match(card.title, /确认创建/);
  assert.ok(card.lines.some((l) => /7 张/.test(l)));
  assert.equal(created.length, 0, '预览不创建');
  await ctl.handle('fs1', click(x.sessionId, 'om_1', 'confirm-create'));
  await ctl.idle();
  await ctl.handle('fs1', click(x.sessionId, 'om_1', 'confirm-create'));
  await ctl.handle('fs1', click(x.sessionId, 'om_1', 'confirm-create', 'u1'));
  await ctl.idle();
  assert.equal(created.length, 1, '同一动作重放不重复确认');
  assert.match(created[0].requestId, /^fs_[0-9a-f]{32}$/);
  assert.deepEqual([created[0].previewId, created[0].revision], ['pv_p1', 'r1']);
  ({ card } = await last(ctl, sent));
  assert.match(card.title, /已创建/);
});
