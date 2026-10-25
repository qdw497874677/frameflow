/**
 * 契约守卫：contracts/openapi.yaml 的 (方法, 路径) 与 buildServer 实际注册的 /api/v1 路由一一对应。
 * 路径参数名不比较（{rootId} 与 :id 视为同一段）；HEAD 由 Fastify 自动生成，不计入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeFixture } from './connector-fixture.mjs';

const PREFIX = '/api/v1';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const shape = (p) => p.replace(/\{[^}]+\}|:[^/]+/g, '{}');

function contractRoutes() {
  const YAML = createRequire(import.meta.url)('yaml');
  const doc = YAML.parse(fs.readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8'));
  return Object.entries(doc.paths).flatMap(([p, ops]) =>
    Object.keys(ops).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${shape(PREFIX + p)}`));
}

/** 解析 printRoutes({ commonPrefix: false }) 的树：每层缩进 4 字符，子节点路径接在父路径后 */
function registeredRoutes(tree) {
  const stack = [];
  return tree.split('\n').flatMap((line) => {
    const m = line.match(/^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?$/);
    if (!m) return [];
    const depth = m[1].length / 4;
    stack.length = depth;
    const full = (stack[depth - 1] ?? '') + m[2];
    stack[depth] = full;
    if (!m[3] || !full.startsWith(PREFIX)) return [];
    return m[3].split(', ').filter((x) => x !== 'HEAD').map((x) => `${x} ${shape(full)}`);
  });
}

test('openapi.yaml 与已注册路由一致', async () => {
  const fx = await makeFixture({ photos: 0 });
  try {
    await fx.start();
    const actual = new Set(registeredRoutes(fx.app.printRoutes({ commonPrefix: false })));
    const contract = new Set(contractRoutes());
    assert.ok(actual.size > 30, '路由树解析失败');
    assert.deepEqual({ 未在契约中: [...actual].filter((r) => !contract.has(r)).sort(), 未实现: [...contract].filter((r) => !actual.has(r)).sort() },
      { 未在契约中: [], 未实现: [] });
  } finally { await fx.dispose(); }
});
