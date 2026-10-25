import test from 'node:test';
import assert from 'node:assert/strict';
import { listPendingTrash } from './trash.ts';

test('Bug 5：待删按所有在线项目汇总，不随当前目录变化', async () => {
  const roots = [
    { id: 'a', path: '/a', label: 'A', online: true },
    { id: 'b', path: '/b', label: 'B', online: true },
    { id: 'c', path: '/c', label: 'C', online: false },
  ];
  const asked: string[] = [];
  const got = await listPendingTrash(roots, async (dir) => { asked.push(dir); return [{ id: `${dir}-1` }] as never; });
  assert.deepEqual(asked, ['/a', '/b']);
  assert.deepEqual(got.map((p) => p.id), ['/a-1', '/b-1']);
});
