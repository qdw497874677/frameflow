/**
 * 实时入库模块对外的全部依赖（端口）。
 *
 * ingest 模块的边界：应用层只认识这里的接口；FTP 服务、目录监听、照片库实现都是适配器，
 * 由组装根接上。`tools/architecture.test.mjs` 守着这条边界。
 */

import type { IngestSourceKind } from '../../domain/ingest/arrival.ts';

/** 来源报告的一次「文件可能到了」 */
export interface IngestArrival {
  readonly rootId: string;
  readonly relDir: string;
  readonly name: string;
  /** true = 来源保证文件已完整落盘（例如 FTP 写临时名、传完再改名），不必再观察稳定 */
  readonly complete: boolean;
}

export interface IngestSink {
  arrived(arrival: IngestArrival): void;
}

/** 入站适配器：FTP 服务、目录监听…… */
export interface IngestSource {
  readonly kind: IngestSourceKind;
  start(sink: IngestSink): Promise<void>;
  stop(): Promise<void>;
  /** 给 `/capabilities` 看的运行状态（不能含密钥） */
  status(): Record<string, unknown>;
}

/** 照片库：只要「把这个目录重新配对入库」一件事（配对规则在扫描里，同目录增量重扫即可） */
export interface IngestCatalog {
  ingestDir(rootId: string, relDir: string): Promise<{ added: string[]; updated: string[] }>;
}

/** 看一眼文件（大小 + mtime）；不在了返回 null */
export interface FileProbe {
  observe(rootId: string, relDir: string, name: string): Promise<{ size: number; mtimeMs: number } | null>;
}

/** 时钟与定时器（测试注入假时钟） */
export interface IngestClock {
  now(): number;
  after(ms: number, fn: () => void): () => void;
}
