// 六边形架构的依赖方向守卫：domain ← application ← adapters ← 组装根（index.ts）。
// 规则见 docs/architecture.md；新增文件必须落在某一层，违规即失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');
const LAYERS = ['domain', 'application', 'adapters'];
const ROOT_FILES = ['index.ts'];
/** 每层允许 import 的层与 node 内建模块（纯计算类，不含 I/O） */
const RULES = {
  domain: { layers: ['domain'], builtins: ['node:path'] },
  application: { layers: ['domain', 'application'], builtins: ['node:path', 'node:crypto', 'node:async_hooks'] },
  adapters: { layers: ['domain', 'application', 'adapters'], builtins: null },
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');
const layerOf = (file) => rel(file).split('/')[0];

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:^|[\n;])\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1] ?? m[2]);
}

function violations(file) {
  const layer = layerOf(file);
  if (ROOT_FILES.includes(rel(file))) return [];
  const rule = RULES[layer];
  if (!rule) return [`${rel(file)}: 不在任何层（domain/application/adapters）`];
  return importsOf(file).flatMap((spec) => {
    if (spec.startsWith('.')) {
      const target = layerOf(path.resolve(path.dirname(file), spec));
      return rule.layers.includes(target) ? [] : [`${rel(file)} → ${spec}（${layer} 不能依赖 ${target}）`];
    }
    if (rule.builtins === null) return [];
    return rule.builtins.includes(spec) ? [] : [`${rel(file)} → ${spec}（${layer} 不能依赖 I/O 或第三方模块）`];
  });
}

test('源码只有三层加组装根', () => {
  const top = fs.readdirSync(SRC).filter((n) => !LAYERS.includes(n) && !ROOT_FILES.includes(n));
  assert.deepEqual(top, []);
});

test('依赖只指向内层', () => {
  assert.deepEqual(walk(SRC).flatMap(violations), []);
});

test('飞书模块只经 adapters/feishu/index.ts 对外', () => {
  const entry = 'adapters/feishu/index.ts';
  const leaks = walk(SRC)
    .filter((f) => !rel(f).startsWith('adapters/feishu/'))
    .flatMap((f) => importsOf(f)
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => rel(path.resolve(path.dirname(f), spec)))
      .filter((target) => target.startsWith('adapters/feishu/') && target !== entry)
      .map((target) => `${rel(f)} → ${target}`));
  assert.deepEqual(leaks, []);
});

// 实时入库（ingest）是一个有边界的模块：外面只经 adapters/ingest/index.ts 用它，
// 它自己也只碰少数共享内核（扩展名分类、库事件、配置类型），不把手伸进照片库实现。
const inIngest = (r) => /^(domain|application|adapters)\/ingest\//.test(r);
const targetsOf = (f) => importsOf(f).filter((spec) => spec.startsWith('.')).map((spec) => rel(path.resolve(path.dirname(f), spec)));

test('入库模块只经 adapters/ingest/index.ts 对外', () => {
  const leaks = walk(SRC)
    .filter((f) => !inIngest(rel(f)))
    .flatMap((f) => targetsOf(f)
      .filter((t) => inIngest(t) && t !== 'adapters/ingest/index.ts')
      .map((t) => `${rel(f)} → ${t}`));
  assert.deepEqual(leaks, []);
});

test('入库模块只依赖共享内核', () => {
  const allowed = new Set(['domain/exts.ts', 'application/library/events.ts', 'adapters/outbound/config-file.ts']);
  const leaks = walk(SRC)
    .filter((f) => inIngest(rel(f)))
    .flatMap((f) => targetsOf(f)
      .filter((t) => !inIngest(t) && !allowed.has(t))
      .map((t) => `${rel(f)} → ${t}`));
  assert.deepEqual(leaks, []);
});

// 光谱胶片引擎适配器（子进程 + 帧协议 + LUT 缓存）是一个有边界的模块：外面只经 adapters/film/index.ts 用它
test('胶片引擎模块只经 adapters/film/index.ts 对外', () => {
  const leaks = walk(SRC)
    .filter((f) => !rel(f).startsWith('adapters/film/'))
    .flatMap((f) => targetsOf(f)
      .filter((t) => t.startsWith('adapters/film/') && t !== 'adapters/film/index.ts')
      .map((t) => `${rel(f)} → ${t}`));
  assert.deepEqual(leaks, []);
});
