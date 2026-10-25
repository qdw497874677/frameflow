/**
 * 连接器注册表（F08）：按 kind 找工厂、维护内存状态。不含平台业务逻辑；
 * 状态只存内存，重启后从 disabled/connecting 重新得出，绝不恢复成假 connected（CC-05）。
 */
import type { ConnectorFactory, ConnectorKind, ConnectorStatus } from '../../domain/connectors/types.ts';

export class ConnectorRegistry {
  readonly #factories = new Map<ConnectorKind, ConnectorFactory>();
  readonly #status = new Map<string, ConnectorStatus>();

  register(kind: ConnectorKind, factory: ConnectorFactory): void {
    if (this.#factories.has(kind)) throw new Error(`CONNECTOR_KIND_DUPLICATE: ${kind}`);
    this.#factories.set(kind, factory);
  }

  factory(kind: ConnectorKind): ConnectorFactory | undefined { return this.#factories.get(kind); }

  status(id: string): ConnectorStatus { return this.#status.get(id) ?? { state: 'disabled' }; }

  setStatus(id: string, status: ConnectorStatus): void { this.#status.set(id, Object.freeze({ ...status })); }

  forget(id: string): void { this.#status.delete(id); }
}
