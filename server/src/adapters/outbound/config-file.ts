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
import { DEFAULT_IGNORE_DIRS } from '../../domain/exts.ts';
import type { RootCfg } from './fs/scan.ts';

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
  /** 是否信任反向代理的 X-Forwarded-*（决定限流取哪个 IP、是否判定为 HTTPS）。默认 false */
  trustProxy?: boolean;
  /** 会话 cookie 的 Secure：auto = 请求为 HTTPS（含受信代理转发的 https）时加；always / never 强制。默认 auto */
  cookieSecure?: 'auto' | 'always' | 'never';
  /** 实时入库（FTP / 目录监听）；null = 关 */
  ingest?: IngestCfg | null;
  /** 光谱胶片引擎（engine/，独立 C++ 进程）；null = 关（缺省） */
  film?: FilmCfg | null;
  /** 配置是从哪个文件读的（运行时添加根目录要写回这里）；null = 没有配置文件（全默认/环境变量） */
  sourceFile: string | null;
}

export interface IngestFtpCfg {
  host: string;
  port: number;
  /** 被动模式数据端口范围（防火墙要放行） */
  pasvMin: number;
  pasvMax: number;
  /** PASV 回给客户端的地址（Tailscale 100.x / 局域网 IP）；空 = 用控制连接的本地地址 */
  pasvUrl: string;
  user: string;
  /** 密码文件（只读第一行）；不在配置里写明文 */
  passwordFile: string;
  /** FTPS（显式 AUTH TLS，索尼相机要求）；不配 = 只允许明文（仅限可信网络） */
  tls: { cert: string; key: string } | null;
  /** 有 tls 时是否强制加密（拒绝明文登录）。默认 true */
  requireTls: boolean;
}

export interface IngestCfg {
  /** 落到哪个项目（根目录 id） */
  rootId: string;
  /** 根目录下的收件目录，支持 `{date}`（YYYY-MM-DD）；默认 `inbox/{date}` */
  subdir: string;
  /** 写入稳定判定的静默时长（毫秒） */
  stableMs: number;
  /** RAW+JPEG 配对窗口（毫秒） */
  pairWindowMs: number;
  /** 监听收件目录（任何方式拷进来的都入库，例如 SMB / rsync / 相机 App） */
  watch: boolean;
  ftp: IngestFtpCfg | null;
}

export interface FilmCfg {
  /** frameflow-film 可执行文件 */
  binary: string;
  /** 胶片数据目录（engine/tools/fetch_stocks.sh 生成） */
  stocksDir: string;
  /** 单个请求超时（毫秒） */
  timeoutMs: number;
  /** 预览 / 导出用的 LUT 边长 */
  lutSize: number;
  /** 引擎线程数；0 = 引擎自己按 CPU 定 */
  threads: number;
  /** 相纸 id；空 = 引擎目录里第一张相纸 */
  paper: string;
  /** 整帧渲染（颗粒 / 光晕导出）的进程池 */
  render: FilmRenderCfg;
}

export interface FilmRenderCfg {
  /** 引擎进程数 = 同时渲染几张（每个进程内部多线程；缺省 1） */
  workers: number;
  /** 超时 = baseMs + msPerMp × 百万像素 */
  baseMs: number;
  msPerMp: number;
  /** 进行中渲染的估计工作内存上限（MB，约 64 B/像素） */
  memoryMb: number;
  /** 单张上限（百万像素） */
  maxMegapixels: number;
}

const ENGINE_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'engine');

/** 功能开关：`film.enabled: true` 或 ARTWORKS_FILM_ENABLED=1 才开，缺省关 */
export function parseFilm(raw: unknown, env: NodeJS.ProcessEnv = process.env): FilmCfg | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const flag = r['enabled'] ?? env['ARTWORKS_FILM_ENABLED'];
  if (!['1', 'true', 'yes'].includes(String(flag ?? 'false').toLowerCase())) return null;
  const num = (v: unknown, d: number) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
  const lutSize = num(r['lutSize'], 33);
  if (!Number.isInteger(lutSize) || lutSize < 2 || lutSize > 65) throw new Error('film.lutSize 要是 2–65 的整数');
  return {
    binary: resolve(expandHome(String(r['binary'] ?? env['ARTWORKS_FILM_BINARY'] ?? join(ENGINE_DIR, 'build', 'frameflow-film')))),
    stocksDir: resolve(expandHome(String(r['stocksDir'] ?? env['ARTWORKS_FILM_STOCKS'] ?? join(ENGINE_DIR, 'data', 'stocks')))),
    timeoutMs: num(r['timeoutMs'], 30_000),
    lutSize,
    threads: num(r['threads'], 0),
    paper: String(r['paper'] ?? ''),
    render: parseFilmRender(r['render'], num),
  };
}

function parseFilmRender(raw: unknown, num: (v: unknown, d: number) => number): FilmRenderCfg {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {
    workers: num(r['workers'], 1),
    baseMs: num(r['baseMs'], 20_000),
    msPerMp: num(r['msPerMp'], 2_000),
    memoryMb: num(r['memoryMb'], 3072),
    maxMegapixels: num(r['maxMegapixels'], 100),
  };
  if (!Number.isInteger(out.workers) || out.workers < 1 || out.workers > 8) throw new Error('film.render.workers 要是 1–8 的整数');
  for (const k of ['baseMs', 'msPerMp', 'memoryMb', 'maxMegapixels'] as const) {
    if (!(out[k] > 0)) throw new Error(`film.render.${k} 要是正数`);
  }
  return out;
}

function parseIngest(raw: unknown): IngestCfg | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['enabled'] === false) return null;
  const rootId = String(r['rootId'] ?? '');
  if (!rootId) throw new Error('ingest.rootId 必填：照片落到哪个项目');
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== null ? Number(v) : d);
  let ftp: IngestFtpCfg | null = null;
  const f = r['ftp'];
  if (f && typeof f === 'object' && (f as Record<string, unknown>)['enabled'] !== false) {
    const fr = f as Record<string, unknown>;
    const tlsRaw = fr['tls'] as Record<string, unknown> | undefined;
    ftp = {
      host: String(fr['host'] ?? '0.0.0.0'),
      port: num(fr['port'], 2121),
      pasvMin: num(fr['pasvMin'], 30000),
      pasvMax: num(fr['pasvMax'], 30009),
      pasvUrl: String(fr['pasvUrl'] ?? ''),
      user: String(fr['user'] ?? 'camera'),
      passwordFile: expandHome(String(fr['passwordFile'] ?? '')),
      tls: tlsRaw && tlsRaw['cert'] && tlsRaw['key'] ? { cert: expandHome(String(tlsRaw['cert'])), key: expandHome(String(tlsRaw['key'])) } : null,
      requireTls: fr['requireTls'] !== false,
    };
    if (!ftp.passwordFile) throw new Error('ingest.ftp.passwordFile 必填（密码不写在配置里）');
    if (ftp.pasvMin > ftp.pasvMax) throw new Error('ingest.ftp.pasvMin 不能大于 pasvMax');
  }
  return {
    rootId,
    subdir: String(r['subdir'] ?? 'inbox/{date}'),
    stableMs: num(r['stableMs'], 2000),
    pairWindowMs: num(r['pairWindowMs'], 3000),
    watch: r['watch'] !== false,
    ftp,
  };
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
    trustProxy: ['1', 'true', 'yes'].includes(String(raw['trustProxy'] ?? process.env['ARTWORKS_TRUST_PROXY'] ?? 'false').toLowerCase()),
    cookieSecure: ((v) => (v === 'always' || v === 'never' ? v : 'auto'))(String(raw['cookieSecure'] ?? process.env['ARTWORKS_COOKIE_SECURE'] ?? 'auto')),
    ingest: parseIngest(raw['ingest']),
    film: parseFilm(raw['film']),
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
