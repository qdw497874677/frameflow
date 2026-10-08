/**
 * 配置：一个 JSON/YAML 文件 + 环境变量覆盖。
 *
 * 设计取向（票 005）：部署要简单 —— 一个进程、一个配置文件、一个数据目录，
 * 没有数据库要先装。库在哪（NAS 挂载点、移动硬盘、本地目录）是配置里的事，不写死在代码里。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml, parseDocument, Document } from 'yaml';
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
    /** 索引里的 `lastScanAt` 比这个还旧就在启动后补扫一次；0 = 关（不补扫） */
    autoRescanAfterDays: number;
  };
  cache: {
    /** 预览缓存上限（字节）。`0` = 不限；超了按 atime 从旧到新删到 90% */
    maxBytes: number;
  };
  logLevel: string;
  /** 配置是从哪个文件读的（运行时添加根目录要写回这里）；null = 没有配置文件（全默认/环境变量） */
  sourceFile: string | null;
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
  const scanRaw = (raw['scan'] as { maxDepth?: number; ignore?: string[]; rootTimeoutMs?: number; autoRescanAfterDays?: number }) ?? {};
  const cacheRaw = (raw['cache'] as { maxBytes?: number }) ?? {};
  // 上限写错（负数/不是数）时当作「不限」：宁可占盘，也不能因为一个手滑的配置把缓存删空
  const maxBytes = Number(cacheRaw.maxBytes ?? process.env['ARTWORKS_CACHE_MAX_BYTES'] ?? 8 * 1024 ** 3);

  return {
    host: String(raw['host'] ?? process.env['ARTWORKS_HOST'] ?? '127.0.0.1'),
    port: Number(raw['port'] ?? process.env['ARTWORKS_PORT'] ?? 8787),
    dataDir: resolve(expandHome(String(raw['dataDir'] ?? process.env['ARTWORKS_DATA_DIR'] ?? defaultDataDir))),
    password: String(raw['password'] ?? process.env['ARTWORKS_PASSWORD'] ?? ''),
    roots,
    scan: {
      maxDepth: Number(scanRaw.maxDepth ?? 8),
      ignore: [...DEFAULT_IGNORE_DIRS, ...(scanRaw.ignore ?? [])],
      rootTimeoutMs: Number(scanRaw.rootTimeoutMs ?? process.env['ARTWORKS_SCAN_TIMEOUT_MS'] ?? 20_000),
      autoRescanAfterDays: Number(scanRaw.autoRescanAfterDays ?? process.env['ARTWORKS_AUTO_RESCAN_DAYS'] ?? 7),
    },
    cache: {
      maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0,
    },
    logLevel: String(raw['logLevel'] ?? process.env['ARTWORKS_LOG_LEVEL'] ?? 'info'),
    sourceFile: file ?? null,
  };
}

/**
 * 运行时添加根目录后把 roots 写回配置文件（重启后仍在）。
 * 用 yaml 的 Document API 保留人写的注释与顺序 —— 配置文件是用户手维护的东西，
 * 不能因为应用写了一次就把注释全部吃掉。
 */
export function persistRoots(cfg: Config): void {
  const file = cfg.sourceFile ?? resolve('artworks.config.local.yaml');
  let doc;
  if (cfg.sourceFile && existsSync(cfg.sourceFile)) {
    doc = parseDocument(readFileSync(cfg.sourceFile, 'utf8'));
  } else {
    doc = new Document({});
  }
  doc.set(
    'roots',
    cfg.roots.map((r) => ({ id: r.id, label: r.label, path: r.path })),
  );
  writeFileSync(file, String(doc), 'utf8');
  cfg.sourceFile = file;
}

export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
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
    out.push({ id, label, path: resolve(expandHome(path)) });
  }
  return out;
}
