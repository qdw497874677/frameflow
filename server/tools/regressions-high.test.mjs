/**
 * 测试报告高优先级问题的回归测试（Bug 1–3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repairJsonl } from '../src/domain/maintenance/data-files.ts';
import { repairDataDir } from '../src/application/maintenance/repair-data-dir.ts';
import { DataDirFiles } from '../src/adapters/outbound/fs/data-dir.ts';
import { loadConfig } from '../src/adapters/outbound/config-file.ts';
import { Library } from '../src/adapters/outbound/fs/library.ts';
import { matchesSelection, selectionFromQuery } from '../src/domain/selection.ts';
import { normalizeProjectId } from '../src/domain/project-id.ts';
import { parseInstance } from '../src/domain/connectors/config.ts';
import { parsePolicy } from '../src/domain/delivery/policy.ts';
import { safeFieldPath } from '../src/adapters/inbound/http/connectors.ts';

const photo = (id, rootId, extra = {}) => ({ id, rootId, relDir: '', meta: {}, kind: 'photo', stars: 0, del: false, ...extra });

test('Bug 1：只带 project 的选择集也按项目过滤', () => {
  const sel = selectionFromQuery('project:A');
  assert.equal(matchesSelection(photo('1', 'A'), sel), true);
  assert.equal(matchesSelection(photo('2', 'B'), sel), false);
  assert.equal(matchesSelection(photo('3', 'B', { stars: 3 }), selectionFromQuery('project:A,stars>=1')), false);
});

test('Bug 2：项目 id 允许 Unicode（NFC 规范化），拒绝控制字符 / 路径分隔符', () => {
  assert.equal(normalizeProjectId('演示作品集'), '演示作品集');
  assert.equal(normalizeProjectId('cafe\u0301'), 'caf\u00e9');
  for (const bad of ['a/b', 'a\\b', 'x\ny', 'z\u200b', '..', '', ' 前空格', 1]) assert.equal(normalizeProjectId(bad), null, String(bad));
});

test('Bug 2：连接器目标 / 创建项目 / 投递策略接受中文项目 id；飞书 id 仍走 ASCII', () => {
  const target = { id: 'g1', connectorId: 'c1', kind: 'group', label: '群', externalId: 'oc_x', projectIds: ['演示作品集'], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false };
  const inst = { id: 'c1', kind: 'feishu', label: 'A', appId: 'cli_1', secretEnv: 'FF_S', tenantId: 't', enabled: false, targets: [target], creatorActorIds: [], creatorProjectIds: ['离线测试'] };
  const out = parseInstance(inst);
  assert.deepEqual(out.targets[0].projectIds, ['演示作品集']);
  assert.deepEqual(out.creatorProjectIds, ['离线测试']);
  assert.throws(() => parseInstance({ ...inst, targets: [{ ...target, externalId: '群一' }] }), /INVALID_FIELD/);
  const p = parsePolicy({ id: 'p1', enabled: true, projectIds: ['演示作品集'], event: 'task.dispatched', targets: [] }, 0);
  assert.deepEqual(p.projectIds, ['演示作品集']);
  assert.throws(() => parsePolicy({ id: 'p1', enabled: true, projectIds: ['a/b'], event: 'task.dispatched', targets: [] }, 0), (e) => e.detail === 'policy.projectIds[0]');
});

test('Bug 2：错误回带字段路径，但不回显夹带用户值的路径', () => {
  assert.equal(safeFieldPath('instance.targets[0].projectIds[1]'), 'instance.targets[0].projectIds[1]');
  assert.equal(safeFieldPath('instance.<script>'), undefined);
  assert.equal(safeFieldPath(undefined), undefined);
});

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-reg-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const LEGACY = '{"photoId":"p1","field":"stars","from":0,"to":3,"by":"me","channel":"web","at":"2026-01-01T00:00:00.000Z"}';
function setup(t, marks) {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'lib'));
  fs.mkdirSync(path.join(d, 'data'));
  fs.writeFileSync(path.join(d, 'data', 'marks.jsonl'), marks);
  const cf = path.join(d, 'c.json');
  fs.writeFileSync(cf, JSON.stringify({ dataDir: path.join(d, 'data'), logLevel: 'silent', port: 0, roots: [{ id: 'r', label: 'r', path: path.join(d, 'lib') }] }));
  return { d, cf, data: path.join(d, 'data') };
}

test('Bug 3：标注日志半截尾行 → 启动时安全截掉并可读出 repair 信息', (t) => {
  const { cf, data } = setup(t, `${LEGACY}\n{"photoId":"p1","fi`);
  const lib = new Library(loadConfig([`--config=${cf}`]));
  assert.equal(lib.marksTailRepair?.code, 'TRUNCATED_TAIL_REPAIRED');
  assert.equal(fs.readFileSync(path.join(data, 'marks.jsonl'), 'utf8'), `${LEGACY}\n`);
});

test('Bug 3：repair 剔除坏的中间行与尾行，原文件先备份', (t) => {
  assert.deepEqual(repairJsonl('{"a":1}\nbroken\n{"a":3}\n{"a'), { text: '{"a":1}\n{"a":3}\n', droppedLines: [2], tailRemoved: true });
  assert.equal(repairJsonl('{"a":1}\n'), null);
  const { data } = setup(t, `${LEGACY}\nnot json\n`);
  const fixed = repairDataDir(new DataDirFiles(data));
  assert.equal(fixed.length, 1);
  assert.deepEqual(fixed[0].droppedLines, [2]);
  assert.equal(fs.readFileSync(path.join(data, 'marks.jsonl'), 'utf8'), `${LEGACY}\n`);
  assert.equal(fs.readFileSync(path.join(data, fixed[0].backup), 'utf8'), `${LEGACY}\nnot json\n`);
});

test('Bug 3：中间行损坏时启动给出友好提示（无堆栈），先报体检结果', (t) => {
  const { cf } = setup(t, `${LEGACY}\nnot json\n`);
  const r = spawnSync(process.execPath, ['src/index.ts', `--config=${cf}`], { encoding: 'utf8', env: { ...process.env, FRAMEFLOW_FEISHU_SDK: 'disabled' }, timeout: 20000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /marks\.jsonl 第 2 行不是合法 JSON/);
  assert.match(r.stderr, /npm run repair/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, '不应打印堆栈');
});
