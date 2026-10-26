/**
 * 实时入库（ingest）适配器的唯一入口：组装根与 HTTP 层只从这里拿入库能力。
 *
 * 模块边界（architecture.test 守着）：
 * - domain/ingest：到达、稳定判定、配对窗口 —— 纯规则；
 * - application/ingest：IngestService + 端口；
 * - adapters/ingest：来源（目录监听、FTP）与文件观察，只经本文件对外。
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestCatalog, IngestClock, IngestSource } from '../../application/ingest/ports.ts';
import { IngestService } from '../../application/ingest/service.ts';
import type { LibraryEventSink } from '../../application/library/events.ts';
import { expandInboxDir } from '../../domain/ingest/arrival.ts';
import type { IngestCfg } from '../outbound/config-file.ts';
import { realClock } from './clock.ts';
import { FtpIngestSource } from './ftp-source.ts';
import { WatchIngestSource } from './watch-source.ts';

export interface IngestLibrary extends IngestCatalog {
  rootPath(rootId: string): string | null;
}

export interface IngestModule {
  readonly service: IngestService;
  /** 今天的收件目录（相对根目录） */
  inboxRel(): string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** FTP 实际监听端口（没开 FTP = null；配置端口 0 时用来找系统分配的） */
  ftpPort(): number | null;
  status(): Record<string, unknown>;
}

const today = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 收件目录模板 `{date}` 之前的固定部分（目录监听从这里开始） */
export function inboxBase(template: string): string {
  const fixed = template.split('{')[0]!;
  const segs = expandInboxDir(fixed, '').split('/').filter(Boolean);
  // 模板若是 "inbox/day-{date}"，最后一段不完整，不能算进固定部分
  if (!fixed.endsWith('/') && template.includes('{')) segs.pop();
  return segs.join('/');
}

export function openIngest(
  cfg: IngestCfg,
  lib: IngestLibrary,
  events: LibraryEventSink,
  opts: { clock?: IngestClock; onError?: (text: string) => void; log?: (text: string) => void; extraSources?: (ctx: { rootPath: string; inboxRel: () => string }) => IngestSource[] } = {},
): IngestModule {
  const rootPath = lib.rootPath(cfg.rootId);
  if (!rootPath) throw new Error(`ingest.rootId 指向不存在的项目：${cfg.rootId}`);
  const clock = opts.clock ?? realClock;
  const inboxRel = () => expandInboxDir(cfg.subdir, today(clock.now()));
  inboxRel(); // 模板不合法就在启动时报
  const sources: IngestSource[] = [];
  if (cfg.watch) sources.push(new WatchIngestSource({ rootId: cfg.rootId, rootPath, baseRel: inboxBase(cfg.subdir) }));
  if (cfg.ftp) sources.push(new FtpIngestSource(cfg.ftp, { rootId: cfg.rootId, rootPath, inboxRel, ...(opts.log ? { log: opts.log } : {}) }));
  sources.push(...(opts.extraSources?.({ rootPath, inboxRel }) ?? []));
  const service = new IngestService(
    {
      sources,
      catalog: lib,
      probe: {
        observe: async (rootId, relDir, name) => {
          const base = lib.rootPath(rootId);
          if (!base) return null;
          try {
            const st = await stat(join(base, ...relDir.split('/').filter(Boolean), name));
            return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
          } catch {
            return null;
          }
        },
      },
      events,
      clock,
      ...(opts.onError ? { onError: opts.onError } : {}),
    },
    { stableMs: cfg.stableMs, pairWindowMs: cfg.pairWindowMs, maxWaitMs: 10 * 60_000 },
  );
  return {
    service,
    inboxRel,
    start: () => service.start(),
    stop: () => service.stop(),
    ftpPort: () => {
      const ftp = sources.find((s): s is FtpIngestSource => s instanceof FtpIngestSource);
      return ftp ? ftp.port : null;
    },
    status: () => ({ enabled: true, rootId: cfg.rootId, inbox: inboxRel(), ...service.status() }),
  };
}
