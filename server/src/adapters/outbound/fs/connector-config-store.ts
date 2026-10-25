import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectorConfigDocument, SanitizedConnectorInstance } from '../../../domain/connectors/types.ts';
import { ConnectorConfigError, EMPTY_CONNECTOR_DOCUMENT, parseDocument, parseNewInstance, sanitize } from '../../../domain/connectors/config.ts';
import type { ConnectorConfigSource } from '../../../application/connectors/ports.ts';

/** connectors.json：非密钥配置，原子替换，目录0700/文件0600。 */
export const CONNECTORS_FILE = 'connectors.json';
const MAX_FILE_BYTES = 1024 * 1024;

export interface ConfigStoreHooks {
  /** 测试注入：替换前调用，抛错模拟写入失败。 */
  readonly beforeRename?: (tmpPath: string) => void;
}

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * connectors.json 存储。单写者由 WriterGuard 在启用前保证（F08 装配）；
 * 本类保证原子替换与 revision 校验：写入失败不发布内存新状态，不丢旧文件。
 */
export class ConnectorConfigStore implements ConnectorConfigSource {
  readonly #file: string;
  readonly #dir: string;
  readonly #hooks: ConfigStoreHooks;
  #current: ConnectorConfigDocument;

  private constructor(dir: string, doc: ConnectorConfigDocument, hooks: ConfigStoreHooks) {
    this.#dir = dir; this.#file = path.join(dir, CONNECTORS_FILE); this.#current = doc; this.#hooks = hooks;
  }

  static open(dataDir: string, hooks: ConfigStoreHooks = {}): ConnectorConfigStore {
    const dir = fs.realpathSync(dataDir);
    const file = path.join(dir, CONNECTORS_FILE);
    let doc: ConnectorConfigDocument;
    let raw: Buffer | undefined;
    try { raw = fs.readFileSync(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (raw === undefined) doc = EMPTY_CONNECTOR_DOCUMENT;
    else {
      if (raw.length > MAX_FILE_BYTES) throw new ConnectorConfigError('CONFIG_TOO_LARGE');
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { throw new ConnectorConfigError('CONFIG_CORRUPT'); }
      doc = parseDocument(parsed);
    }
    return new ConnectorConfigStore(dir, doc, hooks);
  }

  get current(): ConnectorConfigDocument { return this.#current; }

  list(env: NodeJS.ProcessEnv = process.env): SanitizedConnectorInstance[] {
    return this.#current.instances.map(i => sanitize(i, env));
  }

  /** 原子替换全部实例；expectedRevision 不符则 REVISION_CONFLICT。 */
  replace(instances: readonly unknown[], expectedRevision: number): ConnectorConfigDocument {
    if (expectedRevision !== this.#current.revision) throw new ConnectorConfigError('REVISION_CONFLICT');
    const next = parseDocument({ version: 1, revision: this.#current.revision + 1, instances });
    const body = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (body.length > MAX_FILE_BYTES) throw new ConnectorConfigError('CONFIG_TOO_LARGE');
    fs.chmodSync(this.#dir, 0o700);
    const tmp = path.join(this.#dir, `.${CONNECTORS_FILE}.${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        let off = 0;
        while (off < body.length) off += fs.writeSync(fd, body, off);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.#hooks.beforeRename?.(tmp);
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    syncDir(this.#dir);
    this.#current = next;
    return next;
  }

  /** 新建实例：强制 enabled=false，appId/id 重复拒绝。 */
  create(input: unknown, expectedRevision: number): ConnectorConfigDocument {
    return this.replace([...this.#current.instances, parseNewInstance(input)], expectedRevision);
  }
}
