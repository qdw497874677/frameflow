import type { IngestClock } from '../../application/ingest/ports.ts';

/** 真时钟：定时器 unref，不拖住进程退出 */
export const realClock: IngestClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};
