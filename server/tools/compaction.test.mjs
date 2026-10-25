import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldCompact } from '../src/domain/maintenance/compaction.ts';
import { JsonlLog } from '../src/adapters/feishu/jsonl.ts';
import { CursorStore } from '../src/adapters/feishu/cursors.ts';
import { SessionStore } from '../src/adapters/feishu/sessions.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ff-compact-'));
const lineCount = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;

test('阈值：小日志与低冗余日志不压缩', () => {
  assert.equal(shouldCompact(999, 1), false);
  assert.equal(shouldCompact(1000, 600), false);
  assert.equal(shouldCompact(1000, 500), true);
});

test('compact 原子替换：内容即快照、权限 0600、不留临时文件', () => {
  const f = path.join(tmp(), 'x.jsonl');
  const log = new JsonlLog(f);
  for (let i = 0; i < 5; i++) log.append({ i });
  log.compact([{ i: 4 }]);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"i":4}\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(`${f}.tmp`));
  assert.equal(log.lines, 1);
});

test('崩溃在 rename 之前：旧日志完整，残留 .tmp 不影响加载', () => {
  const f = path.join(tmp(), 'x.jsonl');
  const log = new JsonlLog(f);
  log.append({ i: 1 });
  log.append({ i: 2 });
  fs.writeFileSync(`${f}.tmp`, '{"i":2}\n{"i":'); // 模拟写临时文件中途崩溃
  assert.deepEqual(new JsonlLog(f).load(), [{ i: 1 }, { i: 2 }]);
});

test('损坏日志拒绝压缩且字节不变', () => {
  const f = path.join(tmp(), 'x.jsonl');
  fs.writeFileSync(f, '{"i":1}\nbad\n{"i":3}\n');
  const log = new JsonlLog(f);
  log.load();
  assert.throws(() => log.compact([]), /STORE_CORRUPT/);
  assert.equal(log.compactIfNeeded(0, () => []), false);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"i":1}\nbad\n{"i":3}\n');
});

test('游标：超过阈值自动压缩为每个目标一行，重启后状态不变', () => {
  const d = tmp();
  const c = new CursorStore(d);
  for (let i = 0; i < 1000; i++) c.set({ jobId: 'j', targetId: `t${i % 2}`, photoId: `p${i}`, messageId: 'm', sessionId: null }, i);
  const f = path.join(d, 'feishu', 'cursors.jsonl');
  assert.ok(lineCount(f) < 1000);
  const before = c.listJob('j');
  assert.deepEqual(new CursorStore(d).listJob('j'), before);
  assert.deepEqual(before.map((x) => x.photoId).sort(), ['p998', 'p999']);
});

test('会话：压缩折叠 message 行，撤销跨压缩与重启仍生效', () => {
  const d = tmp();
  const s = new SessionStore(d);
  const a = s.create({ jobId: 'j', connectorId: 'c', tenantId: 't', targetId: 'g' }, 0);
  const b = s.create({ jobId: 'j', connectorId: 'c', tenantId: 't', targetId: 'g' }, 0);
  s.revoke(a.sessionId);
  for (let i = 0; i < 1000; i++) s.bindMessage(b.sessionId, `m${i}`);
  assert.ok(lineCount(path.join(d, 'feishu', 'sessions.jsonl')) < 1000);
  const r = new SessionStore(d);
  assert.equal(r.get(b.sessionId).messageId, 'm999');
  assert.equal(r.revoked(a.sessionId), true);
  assert.equal(r.revoked(b.sessionId), false);
});
