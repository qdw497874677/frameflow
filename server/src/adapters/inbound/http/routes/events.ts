/** 库事件流（SSE）：新照片入库时推给前端「新到 N 张」 */

import type { FastifyInstance } from 'fastify';
import type { LibraryEvent, LibraryEventLog } from '../../../../application/library/events.ts';

export interface EventRouteDeps {
  readonly events: LibraryEventLog;
  /** 心跳间隔（毫秒）：穿过代理 / Tailscale Funnel 时防空闲断开 */
  readonly heartbeatMs?: number;
}

export function registerEventRoutes(app: FastifyInstance, { events, heartbeatMs = 25_000 }: EventRouteDeps): void {
  const open = new Set<() => void>();
  // 停服时把挂着的长连接都收掉，不然 close() 会一直等它们
  app.addHook('onClose', async () => { for (const end of [...open]) end(); });
  app.get('/api/v1/library/events', (req, reply) => {
    const q = req.query as { since?: string };
    const lastId = Number(req.headers['last-event-id'] ?? q.since ?? events.lastSeq);
    const since = Number.isFinite(lastId) && lastId >= 0 ? Math.floor(lastId) : events.lastSeq;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: LibraryEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write(`retry: 3000\n\n`);
    const backlog = events.since(since);
    // 补不上（缓冲已丢）：让客户端整页刷新
    if (backlog.gap) res.write(`event: resync\ndata: ${JSON.stringify({ lastSeq: events.lastSeq })}\n\n`);
    else for (const e of backlog.events) send(e);
    res.write(`event: ready\ndata: ${JSON.stringify({ lastSeq: events.lastSeq })}\n\n`);
    const off = events.subscribe(send);
    const beat = setInterval(() => res.write(`: ping\n\n`), heartbeatMs);
    beat.unref?.();
    const close = () => {
      off();
      clearInterval(beat);
      open.delete(end);
    };
    const end = () => {
      close();
      res.end();
    };
    open.add(end);
    req.raw.on('close', close);
  });
}
