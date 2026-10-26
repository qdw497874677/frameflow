import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactText } from './artifacts.ts';
import { itemsProgress } from '../../core/progress.ts';

test('产物说明：导出目录不套批注链接的话术', () => {
  assert.equal(artifactText('dir', true).label, '导出目录');
  assert.doesNotMatch(artifactText('dir', true).hint ?? '', /token|链接/);
  assert.match(artifactText('url', true).hint ?? '', /范围 token/);
  assert.match(artifactText('url', false).hint ?? '', /失效/);
});

test('进度：skipped 不算（与服务端 jobProgress 一致）', () => {
  assert.deepEqual(itemsProgress([{ status: 'planned' }, { status: 'skipped' }]), { done: 0, total: 1 });
});
