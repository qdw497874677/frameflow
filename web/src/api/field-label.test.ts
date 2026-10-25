import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldLabel } from './field-label.ts';

test('Bug 2：配置错误的字段路径翻成可读位置', () => {
  assert.equal(fieldLabel('instance.targets[0].projectIds[1]'), '目标 第 1 项 › 授权项目 第 2 项');
  assert.equal(fieldLabel('instance.creatorProjectIds[0]'), '可创建任务的项目 第 1 项');
  assert.equal(fieldLabel(undefined), null);
});
