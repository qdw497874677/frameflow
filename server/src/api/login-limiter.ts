/**
 * 登录限流（按 IP，内存）：前 FREE 次失败不限；之后每次失败锁定 base·2^(n-FREE) 毫秒，封顶 max。
 * 锁定期内的尝试直接 429（不校验密码、不延长锁定），成功登录清零。
 * 记录在 idleMs 无活动后清理，表大小有上限防内存放大。进程重启即清零（单进程自托管足够）。
 */
export interface LimiterOptions { free?: number; baseMs?: number; maxMs?: number; idleMs?: number; maxEntries?: number; now?: () => number }

export class LoginLimiter {
  readonly #o: Required<LimiterOptions>;
  readonly #m = new Map<string, { fails: number; until: number; last: number }>();
  constructor(o: LimiterOptions = {}) {
    this.#o = { free: 5, baseMs: 1000, maxMs: 15 * 60_000, idleMs: 60 * 60_000, maxEntries: 10_000, now: Date.now, ...o };
  }
  /** 锁定中返回剩余毫秒，否则 0 */
  blockedFor(ip: string): number {
    const e = this.#m.get(ip);
    if (!e) return 0;
    return Math.max(0, e.until - this.#o.now());
  }
  fail(ip: string): number {
    const now = this.#o.now();
    this.#sweep(now);
    const e = this.#m.get(ip) ?? { fails: 0, until: 0, last: now };
    e.fails++; e.last = now;
    if (e.fails > this.#o.free) e.until = now + Math.min(this.#o.maxMs, this.#o.baseMs * 2 ** (e.fails - this.#o.free - 1));
    this.#m.delete(ip); this.#m.set(ip, e);
    return Math.max(0, e.until - now);
  }
  success(ip: string): void { this.#m.delete(ip); }
  #sweep(now: number): void {
    for (const [k, e] of this.#m) if (now - e.last > this.#o.idleMs && e.until <= now) this.#m.delete(k);
    while (this.#m.size >= this.#o.maxEntries) this.#m.delete(this.#m.keys().next().value as string);
  }
}
