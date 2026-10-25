import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesFileName, projectListVisible } from './file-search.ts';

test('Bug 7：搜索时项目文件列表让位给结果，只显示命中项', () => {
  const photos = [
    { displayName: 'IMG_1013', jpegPath: '/p/IMG_1013.JPG' },
    { displayName: 'DSC_0001', rawPath: '/p/DSC_0001.NEF' },
  ];
  assert.deepEqual(photos.filter((p) => matchesFileName(p, '1013')).map((p) => p.displayName), ['IMG_1013']);
  assert.equal(matchesFileName(photos[1], 'nef'), true, '按 RAW 文件名也能搜到');
  assert.equal(matchesFileName(photos[0], '  '), false);
  assert.equal(projectListVisible(true), false);
  assert.equal(projectListVisible(false), true);
});
