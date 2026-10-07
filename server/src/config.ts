/**
 * 配置：一个 JSON/YAML 文件 + 环境变量覆盖。
 *
 * 设计取向（票 005）：部署要简单 —— 一个进程、一个配置文件、一个数据目录，
 * 没有数据库要先装。库在哪（NAS 挂载点、移动硬盘、本地目录）是配置里的事，不写死在代码里。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_IGNORE_DIRS } from './core/exts.ts';
import type { RootCfg } from './core/scan.ts';

export interface Config {
  host: string;
  port: number;
  /** 索引 / 缩略图 / 日志 / token 的落脚处。**不能放在照片共享里**（NAS 上写小文件很慢）。 */
  dataDir: string;
  /** 空字符串 = 免认证（只在本机开发时这么用） */
  password: string;
  roots: RootCfg[];
  scan: {
    maxDepth: number;
    ignore: string[];
    /** 单个根目录的扫描超时（毫秒）。网络挂载失联时 FS 调用永不返回，没有这道闸就把服务拖住 */
    rootTimeoutMs: number;
  };
  logLevel: string;
}

export function loadConfig(argv = process.argv.slice(2)): Config {
  const flagPath = argv.find((a) => a.startsWith('--config='))?.slice('--config='.length);
  const candidates = [flagPath, process.env['ARTWORKS_CONFIG'], 'artworks.config.yaml', 'artworks.config.yml', 'artworks.config.json']
    .filter((p): p is string => Boolean(p))
    .map((p) => resolve(p));

  const file = candidates.find((p) => existsSync(p));
  const raw: Record<string, unknown> = file
    ? (parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {}
    : {};

  const rootsRaw = (raw['roots'] as unknown[]) ?? [];
  const roots = normalizeRoots(
    rootsRaw.length
      ? rootsRaw
      : (process.env['ARTWORKS_ROOTS'] ?? '')
          .split(',')
          .filter(Boolean)
          .map((p) => ({ path: p.trim() })),
  );

  const defaultDataDir = resolve(homedir(), '.local/share/artworks');
  const scanRaw = (raw['scan'] as { maxDepth?: number; ignore?: string[]; rootTimeoutMs?: number }) ?? {};

  return {
    host: String(raw['host'] ?? process.env['ARTWORKS_HOST'] ?? '127.0.0.1'),
    port: Number(raw['port'] ?? process.env['ARTWORKS_PORT'] ?? 8787),
    dataDir: resolve(String(raw['dataDir'] ?? process.env['ARTWORKS_DATA_DIR'] ?? defaultDataDir)),
    password: String(raw['password'] ?? process.env['ARTWORKS_PASSWORD'] ?? ''),
    roots,
    scan: {
      maxDepth: Number(scanRaw.maxDepth ?? 8),
      ignore: [...DEFAULT_IGNORE_DIRS, ...(scanRaw.ignore ?? [])],
      rootTimeoutMs: Number(scanRaw.rootTimeoutMs ?? process.env['ARTWORKS_SCAN_TIMEOUT_MS'] ?? 20_000),
    },
    logLevel: String(raw['logLevel'] ?? process.env['ARTWORKS_LOG_LEVEL'] ?? 'info'),
  };
}

function normalizeRoots(list: unknown[]): RootCfg[] {
  const used = new Set<string>();
  const out: RootCfg[] = [];
  for (const item of list) {
    const obj = typeof item === 'string' ? { path: item } : (item as Record<string, unknown>);
    const path = obj['path'];
    if (typeof path !== 'string' || !path.trim()) continue;
    const label = String(obj['label'] ?? obj['id'] ?? basename(resolve(path)));
    let id = String(obj['id'] ?? label);
    let n = 2;
    while (used.has(id)) id = `${label}-${n++}`;
    used.add(id);
    out.push({ id, label, path: resolve(path) });
  }
  return out;
}
