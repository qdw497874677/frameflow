/**
 * 连接器运行时（F08）：按配置启动/停用实例，单写者保护，发送前再授权。
 *
 * - 未启用实例零连接；启用实例各自独立启动/停止（CC-01）。
 * - 坏环境变量引用只给脱敏代码（SECRET_ENV_MISSING/EMPTY），不打印值（CC-02）。
 * - 单写者：启动任何实例前必须取得 WriterLock；
 *   另一个活着的进程持有时全部实例进入 error/SINGLE_WRITER_LOCKED。
 * - test() 只调用 verify()，不发送任何消息（CC-07）。
 * - send()/update() 在执行时刻重读配置：实例停用、目标被删即拒绝（CC-06 排队前再授权）。
 */
import { resolveSecret, type SecretEnv } from '../../domain/connectors/config.ts';
import type { ConnectorConfigSource, WriterLock } from './ports.ts';
import { ConnectorRegistry } from './registry.ts';
import type {
  ConnectorEvent, ConnectorInstanceConfig, ConnectorStatus, DeliveryResult, EventAck,
  ManagedConnectorPort, SendInput, UpdateInput, VerifyResult,
} from '../../domain/connectors/types.ts';

export type EventHandler = (connectorId: string, event: ConnectorEvent) => Promise<EventAck>;

export class ConnectorRuntime {
  readonly #running = new Map<string, { port: ManagedConnectorPort; fingerprint: string }>();
  #lockHeld = false;

  readonly store: ConnectorConfigSource;
  readonly registry: ConnectorRegistry;
  readonly lock: WriterLock;
  readonly onEvent: EventHandler;
  readonly env: SecretEnv;

  constructor(store: ConnectorConfigSource, registry: ConnectorRegistry, lock: WriterLock, onEvent: EventHandler, env: SecretEnv) {
    this.store = store;
    this.registry = registry;
    this.lock = lock;
    this.onEvent = onEvent;
    this.env = env;
  }

  status(id: string): ConnectorStatus { return this.registry.status(id); }
  isRunning(id: string): boolean { return this.#running.has(id); }

  /** 取得单写者锁（已持有则直接成功）。 */
  acquireWriter(): boolean {
    if (!this.#lockHeld) this.#lockHeld = this.lock.acquire();
    return this.#lockHeld;
  }

  releaseWriter(): void {
    if (!this.#lockHeld) return;
    this.lock.release();
    this.#lockHeld = false;
  }

  /** 让运行状态与配置对齐。 */
  async sync(): Promise<void> {
    const wanted = new Map(this.store.current.instances.filter(i => i.enabled).map(i => [i.id, i]));
    for (const [id, run] of [...this.#running]) {
      const inst = wanted.get(id);
      if (!inst || fingerprint(inst) !== run.fingerprint) await this.#stop(id);
    }
    for (const inst of this.store.current.instances) {
      if (!inst.enabled) { this.registry.setStatus(inst.id, { state: 'disabled' }); continue; }
      if (this.#running.has(inst.id)) continue;
      await this.#start(inst);
    }
    const known = new Set(this.store.current.instances.map(i => i.id));
    for (const id of [...this.#running.keys()]) if (!known.has(id)) await this.#stop(id);
  }

  async #start(inst: ConnectorInstanceConfig): Promise<void> {
    if (!this.acquireWriter()) { this.registry.setStatus(inst.id, { state: 'error', reason: 'SINGLE_WRITER_LOCKED' }); return; }
    const secret = resolveSecret(inst, this.env);
    if (!secret.ok) { this.registry.setStatus(inst.id, { state: 'error', reason: secret.code }); return; }
    const factory = this.registry.factory(inst.kind);
    if (!factory) { this.registry.setStatus(inst.id, { state: 'error', reason: 'CONNECTOR_KIND_UNSUPPORTED' }); return; }
    this.registry.setStatus(inst.id, { state: 'connecting' });
    const port = factory(inst, secret.secret);
    try {
      await port.start(ev => this.#dispatchEvent(inst.id, ev));
      this.#running.set(inst.id, { port, fingerprint: fingerprint(inst) });
      this.registry.setStatus(inst.id, { state: 'connected', lastConnectedAt: new Date().toISOString() });
    } catch {
      try { await port.stop(); } catch { /* 已失败 */ }
      this.registry.setStatus(inst.id, { state: 'error', reason: 'CONNECT_FAILED' });
    }
  }

  async #stop(id: string): Promise<void> {
    const run = this.#running.get(id);
    this.#running.delete(id);
    if (run) { try { await run.port.stop(); } catch { /* 停止失败不阻塞停用 */ } }
    this.registry.setStatus(id, { state: 'disabled' });
  }

  async #dispatchEvent(id: string, ev: ConnectorEvent): Promise<EventAck> {
    // 事件到达时重查：已停用实例不再接收（停用阻止新外传，也不受理旧卡）
    const inst = this.#instance(id);
    if (!inst?.enabled || !this.#running.has(id)) return { kind: 'rejected', code: 'CONNECTOR_DISABLED' };
    if (ev.identity.connectorId !== id) return { kind: 'rejected', code: 'CONNECTOR_MISMATCH' };
    return this.onEvent(id, ev);
  }

  #instance(id: string): ConnectorInstanceConfig | undefined {
    return this.store.current.instances.find(i => i.id === id);
  }

  #gate(connectorId: string, targetId: string): ManagedConnectorPort | DeliveryResult {
    const inst = this.#instance(connectorId);
    if (!inst || !inst.enabled) return { status: 'failed', code: 'CONNECTOR_DISABLED', retryable: false };
    if (!inst.targets.some(t => t.id === targetId)) return { status: 'failed', code: 'TARGET_REVOKED', retryable: false };
    const run = this.#running.get(connectorId);
    if (!run) return { status: 'failed', code: 'CONNECTOR_NOT_CONNECTED', retryable: true };
    return run.port;
  }

  /** 排队任务执行前调用：此刻重新授权，而不是入队时。 */
  async send(connectorId: string, input: SendInput): Promise<DeliveryResult> {
    const port = this.#gate(connectorId, input.targetId);
    return 'send' in port ? port.send(input) : port;
  }

  async update(connectorId: string, input: UpdateInput): Promise<DeliveryResult> {
    const port = this.#gate(connectorId, input.targetId);
    return 'update' in port ? port.update(input) : port;
  }

  /** 测试连接：只验证，不发消息；未启用实例临时建端口验证后丢弃（不 start）。 */
  async test(connectorId: string): Promise<VerifyResult> {
    const inst = this.#instance(connectorId);
    if (!inst) return { ok: false, code: 'CONNECTOR_NOT_FOUND' };
    const run = this.#running.get(connectorId);
    if (run) return run.port.verify();
    const secret = resolveSecret(inst, this.env);
    if (!secret.ok) return { ok: false, code: secret.code };
    const factory = this.registry.factory(inst.kind);
    if (!factory) return { ok: false, code: 'CONNECTOR_KIND_UNSUPPORTED' };
    try { return await factory(inst, secret.secret).verify(); } catch { return { ok: false, code: 'VERIFY_FAILED' }; }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.#running.keys()]) await this.#stop(id);
    this.releaseWriter();
  }
}

function fingerprint(i: ConnectorInstanceConfig): string {
  return JSON.stringify([i.appId, i.secretEnv, i.tenantId]);
}
