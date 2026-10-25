/** 连接器运行时依赖的出站端口。 */
import type { ConnectorConfigDocument } from '../../domain/connectors/types.ts';

/** 当前生效的连接器配置（实现：adapters/outbound/fs/connector-config-store.ts） */
export interface ConnectorConfigSource {
  readonly current: ConnectorConfigDocument;
}

/** 单写者锁：同一 dataDir 只允许一个进程启用连接器（实现：adapters/outbound/fs/writer-lock.ts） */
export interface WriterLock {
  /** 取得锁；另一个活着的进程持有时返回 false */
  acquire(): boolean;
  release(): void;
}
