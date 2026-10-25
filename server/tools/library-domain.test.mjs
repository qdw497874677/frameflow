import assert from 'node:assert/strict';
import test from 'node:test';
import { FolderTree } from '../src/domain/library/folder-tree.ts';
import { encodeCursor, pageAfter } from '../src/domain/library/paging.ts';
import { fileOf, sidecarOf } from '../src/domain/library/photo-files.ts';

const rec = (id, relDir, displayName = id) => ({ id, rootId: 'r', relDir, displayName, kind: 'photo', previewPath: `/${id}` });

test('目录树：递归计数、每级父子边、根即使为空也存在', () => {
  const t = new FolderTree();
  t.rebuild([rec('a', 'x/y'), rec('b', 'x'), rec('c', 'x/y')], ['r', 'empty']);
  assert.equal(t.photoCount('/r'), 3);
  assert.equal(t.directCount('/r/x'), 1);
  assert.deepEqual(t.subfolders('/r').map((f) => f.path), ['/r/x']);
  assert.deepEqual(t.under('/r/x').map((r) => r.id), ['b', 'a', 'c']);
  assert.ok(t.has('/empty'));
});

test('分页：游标指向上一页最后一张，未知游标从头开始', () => {
  const list = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.deepEqual(pageAfter(list, encodeCursor('a'), 1), { page: [{ id: 'b' }], more: true });
  assert.deepEqual(pageAfter(list, encodeCursor('zz'), 5), { page: list, more: false });
});

test('文件映射：auto 优先 JPEG，XMP 用 stem 命名', () => {
  const r = { ...rec('a', ''), displayName: 'DSC1', raw: { path: '/p/DSC1.ARW', ext: '.ARW' }, jpeg: { path: '/p/DSC1.JPG', ext: '.JPG' } };
  assert.deepEqual(fileOf(r, 'auto'), { path: '/p/DSC1.JPG', name: 'DSC1.JPG', mime: 'image/jpeg' });
  assert.equal(sidecarOf(r), '/p/DSC1.xmp');
});
