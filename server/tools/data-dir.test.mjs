import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkDataDir } from '../src/application/maintenance/check-data-dir.ts';
import { DataDirFiles, backupDataDir } from '../src/adapters/outbound/fs/data-dir.ts';

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-data-'));
  fs.writeFileSync(path.join(d, 'jobs.jsonl'), '{"a":1}\n{"a":2}\n{"a":');
  fs.writeFileSync(path.join(d, 'marks.jsonl'), '{"a":1}\nbroken\n{"a":3}\n');
  fs.writeFileSync(path.join(d, 'index.json'), '{"photos":[]}');
  fs.writeFileSync(path.join(d, 'policy.json'), '{oops');
  fs.writeFileSync(path.join(d, 'tokens.json.tmp'), '{}');
  fs.mkdirSync(path.join(d, 'feishu'));
  fs.writeFileSync(path.join(d, 'feishu', 'sessions.jsonl'), '{"s":1}\n');
  fs.mkdirSync(path.join(d, 'thumbs'));
  fs.writeFileSync(path.join(d, 'thumbs', 'x.json'), 'junk');
  return d;
}

test('体检：坏中间行与坏 json 为错误，崩溃尾行与临时文件为警告，缩略图目录跳过', () => {
  const got = checkDataDir(new DataDirFiles(fixture())).map((f) => `${f.severity}:${f.file}`).sort();
  assert.deepEqual(got, ['error:marks.jsonl', 'error:policy.json', 'warning:jobs.jsonl', 'warning:tokens.json.tmp']);
});

test('体检：健康目录无发现', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ok-'));
  fs.writeFileSync(path.join(d, 'jobs.jsonl'), '{"a":1}\n');
  assert.deepEqual(checkDataDir(new DataDirFiles(d)), []);
});

test('备份：复制数据文件（含子目录），跳过临时文件与缩略图，manifest 校验和一致', () => {
  const src = fixture();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bak-'));
  const { dir, files } = backupDataDir(new DataDirFiles(src), dest, new Date('2026-01-02T03:04:05Z'));
  assert.equal(path.basename(dir), 'frameflow-backup-2026-01-02T03-04-05-000Z');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(files, 5);
  assert.deepEqual(manifest.files.map((f) => f.file).sort(), ['feishu/sessions.jsonl', 'index.json', 'jobs.jsonl', 'marks.jsonl', 'policy.json']);
  for (const f of manifest.files) {
    const buf = fs.readFileSync(path.join(src, f.file));
    assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'thumbs')));
});

test('备份：目标在数据目录内或数据目录不存在时拒绝', () => {
  const src = fixture();
  assert.throws(() => backupDataDir(new DataDirFiles(src), path.join(src, 'bak')), /不能在数据目录内/);
  assert.throws(() => backupDataDir(new DataDirFiles(path.join(src, 'nope')), os.tmpdir()), /数据目录不存在/);
});
