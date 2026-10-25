/**
 * 测试报告遗留项的回归测试：
 *  - repair 绝不丢带版本的标注事务（剔行会断版本链时拒绝改写；改写前总有不覆盖的备份）
 *  - 侧边栏目录计数不含待删（和挑片列表同口径），待删数单独给出
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture } from './connector-fixture.mjs';
import { repairJsonl } from '../src/domain/maintenance/data-files.ts';
import { repairDataDir } from '../src/application/maintenance/repair-data-dir.ts';
import { DataDirFiles } from '../src/adapters/outbound/fs/data-dir.ts';
import { MarksLog } from '../src/adapters/outbound/fs/marks-log.ts';

async function versionedLog(t) {
  const fx = await makeFixture({ photos: 2 });
  t.after(() => fx.dispose());
  const [a, b] = (await fx.call('GET', '/api/v1/photos?dir=/p')).json.items.map((p) => p.id);
  for (const [id, stars] of [[a, 3], [b, 4], [a, 5]]) assert.equal((await fx.call('PUT', '/api/v1/marks', { items: [{ id, stars }] })).status, 200);
  const file = path.join(fx.dataDir, 'marks.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 3 && lines.every((l) => JSON.parse(l).version === 1), '夹具应写出带版本的事务行');
  return { fx, file, lines };
}

test('repair：坏行在带版本事务之前/之中 → 拒绝改写，文件逐字节不变', async (t) => {
  const { fx, file, lines } = await versionedLog(t);
  const original = `${lines[0]}\nnot json\n${lines.slice(1).join('\n')}\n`;
  fs.writeFileSync(file, original);
  const out = repairDataDir(new DataDirFiles(fx.dataDir));
  const marks = out.find((f) => f.file === 'marks.jsonl');
  assert.ok(marks && 'refused' in marks, '应拒绝');
  assert.deepEqual(marks.droppedLines, [2]);
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  // 坏掉的就是一条版本事务（截了一半）也一样拒绝，哪怕它在最后一个完整行
  const mangled = `${lines.join('\n')}\n${lines[2].slice(0, 40)}\n`;
  assert.ok('refused' in repairJsonl(mangled, { preserveVersioned: true }));
  // 只是没写完的尾行：照常截掉（启动本来也会这么做），所有版本都在
  const tail = repairJsonl(`${lines.join('\n')}\n{"vers`, { preserveVersioned: true });
  assert.equal(tail.text, `${lines.join('\n')}\n`);
});

test('repair：坏行在所有版本之后 → 照常剔除，原文件先备份，版本链完整可读', async (t) => {
  const { fx, file, lines } = await versionedLog(t);
  const original = `${lines.join('\n')}\nnot json\n`;
  fs.writeFileSync(file, original);
  const dir = new DataDirFiles(fx.dataDir);
  const [fixed] = repairDataDir(dir);
  assert.equal(fs.readFileSync(path.join(fx.dataDir, fixed.backup), 'utf8'), original);
  assert.equal(new MarksLog(file).rows.length, lines.length, '所有版本都保留');

  // 同一时刻再修一次：备份不覆盖前一个
  fs.writeFileSync(file, original);
  const now = new Date('2026-01-01T00:00:00Z');
  const b1 = dir.backupAndReplace('marks.jsonl', `${lines.join('\n')}\n`, now);
  fs.writeFileSync(file, `${original}x\n`);
  const b2 = dir.backupAndReplace('marks.jsonl', `${lines.join('\n')}\n`, now);
  assert.notEqual(b1, b2);
  assert.equal(fs.readFileSync(path.join(fx.dataDir, b1), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(fx.dataDir, b2), 'utf8'), `${original}x\n`);
});

test('侧边栏计数：待删不算进目录照片数，待删数单独给出', async (t) => {
  const fx = await makeFixture({ photos: 3 });
  t.after(() => fx.dispose());
  const [id] = (await fx.call('GET', '/api/v1/photos?dir=/p')).json.items.map((p) => p.id);
  assert.equal((await fx.call('PUT', '/api/v1/marks', { items: [{ id, del: true }] })).status, 200);
  const top = (await fx.call('GET', '/api/v1/folders')).json;
  assert.equal(top.folders.find((f) => f.path === '/p').photoCount, 2);
  const listing = (await fx.call('GET', '/api/v1/folders?path=/p')).json;
  assert.equal(listing.photoCount, 2);
  assert.equal(listing.deletedCount, 1);
  assert.equal((await fx.call('GET', '/api/v1/photos?dir=/p')).json.total, listing.photoCount, '与挑片列表同口径');
});
