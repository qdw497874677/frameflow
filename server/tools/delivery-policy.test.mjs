import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyStore, matchTargets, POLICIES_FILE } from '../src/delivery/policies.ts';
import { PreviewService, PREVIEW_TTL_MS } from '../src/delivery/previews.ts';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const tgt = (id, projectIds = ['p1'], label = id) => ({ id, label, projectIds });
const connectors = (over = {}) => ({ version: 1, revision: 3, instances: [
  { id: 'c1', enabled: true, targets: [tgt('g1'), tgt('g2')] },
  { id: 'c2', enabled: true, targets: [tgt('g3'), tgt('gx', ['p2'])] },
  { id: 'c3', enabled: false, targets: [tgt('g4')] },
], ...over });
const pol = (id, over = {}) => ({ id, enabled: true, projectIds: ['p1'], event: 'task.dispatched', targets: [], ...over });
const params = { alias: null, note: null, notifyOnComplete: false };

test('DP-02 匹配：项目+事件、去重、空 projectIds 不匹配、禁用不匹配', (t) => {
  const s = PolicyStore.open(tmp(t));
  const doc = s.replace([
    pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c2', targetId: 'g3' }] }),
    pol('b', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c1', targetId: 'g2' }] }),
    pol('c', { projectIds: [], targets: [{ connectorId: 'c9', targetId: 'z' }] }),
    pol('d', { enabled: false, targets: [{ connectorId: 'c9', targetId: 'y' }] }),
    pol('e', { event: 'task.completed', targets: [{ connectorId: 'c9', targetId: 'w' }] }),
  ], 0);
  assert.deepEqual(matchTargets(doc, 'p1', 'task.dispatched').map((x) => x.targetId), ['g1', 'g3', 'g2']);
  assert.deepEqual(matchTargets(doc, 'p1', 'task.completed').map((x) => x.targetId), ['w']);
  assert.deepEqual(matchTargets(doc, 'p2', 'task.dispatched'), []);
});

test('策略存储：原子、0600、revision 冲突、未知字段拒绝、重开一致、未改动策略保留 revision', (t) => {
  const dir = tmp(t);
  const s = PolicyStore.open(dir);
  s.replace([pol('a'), pol('b')], 0);
  assert.equal(fs.statSync(path.join(dir, POLICIES_FILE)).mode & 0o777, 0o600);
  assert.throws(() => s.replace([pol('a')], 0), { code: 'REVISION_CONFLICT' });
  assert.throws(() => s.replace([{ ...pol('a'), chatId: 'oc_x' }], 1), { code: 'UNKNOWN_FIELD' });
  assert.throws(() => s.replace([pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1', path: '/x' }] })], 1), { code: 'UNKNOWN_FIELD' });
  const d2 = s.replace([pol('a'), pol('b', { enabled: false })], 1);
  assert.equal(d2.policies[0].revision, 1);
  assert.equal(d2.policies[1].revision, 2);
  assert.deepEqual(PolicyStore.open(dir).current, d2);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('DP-01/DP-05 预览：零发送、不可变、去重、过期、陈旧、取消、非法目标', (t) => {
  let now = 1_000_000;
  const svc = new PreviewService(() => now);
  const s = PolicyStore.open(tmp(t));
  s.replace([pol('a', { targets: [{ connectorId: 'c1', targetId: 'g1' }, { connectorId: 'c3', targetId: 'g4' }] })], 0);
  let state = { connectors: connectors(), policies: s.current };

  const r = svc.create({ projectId: 'p1', photoIds: ['x2', 'x1', 'x1'], params }, state);
  assert.equal(r.ok, true);
  const p = r.preview;
  assert.deepEqual(p.photoIds, ['x1', 'x2']);
  assert.deepEqual(p.targets.map((x) => x.targetId), ['g1']);
  assert.ok(p.warnings.includes('POLICY_TARGET_UNAVAILABLE'));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.targets));
  assert.equal(Date.parse(p.expiresAt) - now, PREVIEW_TTL_MS);

  // 用户显式选择：去重；不在允许集合内拒绝（禁用实例 / 其他项目 / 未知）
  const sel = svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [{ connectorId: 'c2', targetId: 'g3' }, { connectorId: 'c2', targetId: 'g3' }] }, state);
  assert.equal(sel.preview.targets.length, 1);
  for (const bad of [{ connectorId: 'c3', targetId: 'g4' }, { connectorId: 'c2', targetId: 'gx' }, { connectorId: 'c1', targetId: 'nope' }]) {
    assert.equal(svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [bad] }, state).code, 'TARGET_NOT_ALLOWED');
  }
  const appOnly = svc.create({ projectId: 'p1', photoIds: ['x1'], params, targets: [] }, state).preview;
  assert.deepEqual(appOnly.targets, []);
  assert.ok(appOnly.warnings.includes('NO_TARGET'));
  assert.equal(svc.create({ projectId: 'p1', photoIds: [], params }, state).code, 'EMPTY_SELECTION');

  assert.equal(svc.check(p.previewId, p.revision, state, ['x1', 'x2']).ok, true);
  assert.equal(svc.check(p.previewId, 'f'.repeat(64), state, ['x1', 'x2']).code, 'PREVIEW_REVISION_MISMATCH');
  assert.equal(svc.check(p.previewId, p.revision, state, ['x1']).detail, 'photos');
  const revoked = connectors({ instances: [{ id: 'c1', enabled: true, targets: [tgt('g1', ['p9'])] }] });
  assert.equal(svc.check(p.previewId, p.revision, { ...state, connectors: revoked }, ['x1', 'x2']).detail, 'target');
  s.replace([pol('a', { targets: [{ connectorId: 'c2', targetId: 'g3' }] })], 1);
  assert.equal(svc.check(p.previewId, p.revision, { ...state, policies: s.current }, ['x1', 'x2']).detail, 'policy');
  now += PREVIEW_TTL_MS;
  assert.equal(svc.check(p.previewId, p.revision, state, ['x1', 'x2']).code, 'PREVIEW_EXPIRED');
  assert.equal(svc.cancel(sel.preview.previewId), true);
  assert.equal(svc.check(sel.preview.previewId, sel.preview.revision, state, ['x1']).code, 'PREVIEW_NOT_FOUND');
  // 服务没有任何发送端口
  assert.equal(Object.getOwnPropertyNames(PreviewService.prototype).some((n) => /send|deliver/i.test(n)), false);
});
