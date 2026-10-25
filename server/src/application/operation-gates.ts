/**
 * 照片/任务共用串行边界（F05/F06）。
 *
 * - 按 key 串行：同一张照片（photo:<id>）或任务（job:<id>）上的写操作排队，互不相关的 key 并行，
 *   一张挂载慢的照片不阻塞别的项目。
 * - 全局顺序 job → photo：同一次 run 内按 (rank, key) 排序加锁；已持有 photo 锁时再申请 job 锁
 *   直接抛 GATE_ORDER_VIOLATION（不等待，杜绝反向取锁死锁）。
 * - 可重入：同一异步调用链已持有的 key 不再等待（内部已持锁方法嵌套调用不死锁）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type GateKey = `job:${string}` | `photo:${string}`;
const rank = (k: string): number => (k.startsWith('job:') ? 0 : 1);
const order = (a: string, b: string): number => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);

export class OperationGates {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  static photo(id: string): GateKey { return `photo:${id}`; }
  static job(id: string): GateKey { return `job:${id}`; }

  /** 当前调用链持有的 key（测试/断言用）。 */
  held(): ReadonlySet<string> { return this.#held.getStore() ?? new Set(); }

  async run<T>(keys: readonly GateKey[], fn: () => Promise<T> | T): Promise<T> {
    const held = this.held();
    const wanted = [...new Set(keys)].filter(k => !held.has(k)).sort(order);
    if (!wanted.length) return fn();
    const maxHeld = Math.max(-1, ...[...held].map(rank));
    if (rank(wanted[0]) < maxHeld) throw new Error(`GATE_ORDER_VIOLATION: ${wanted[0]} after photo lock`);
    // 若已持有同 rank 的 key，新 key 必须排在其后，否则两条链可能交叉等待。
    const lastHeld = [...held].sort(order).at(-1);
    if (lastHeld && order(wanted[0], lastHeld) < 0) throw new Error(`GATE_ORDER_VIOLATION: ${wanted[0]} before ${lastHeld}`);
    const releases: (() => void)[] = [];
    try {
      for (const key of wanted) {
        const prev = this.#tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>(r => { release = r; });
        const tail = prev.then(() => mine);
        this.#tails.set(key, tail);
        releases.push(() => { release(); if (this.#tails.get(key) === tail) this.#tails.delete(key); });
        await prev;
      }
      const next = new Set([...held, ...wanted]);
      return await this.#held.run(next, fn);
    } finally {
      for (const r of releases.reverse()) r();
    }
  }
}
