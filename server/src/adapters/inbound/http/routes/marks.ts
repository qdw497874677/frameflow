/** 标注与回收站 */

import type { FastifyInstance } from 'fastify';
import { hasInvalidStars, type MarkInput } from '../../../../domain/marks.ts';
import type { Library } from '../../../outbound/fs/library.ts';
import { idsOf, infoOf } from '../request.ts';

export interface MarksRouteDeps {
  readonly lib: Library;
}

export function registerMarksRoutes(app: FastifyInstance, { lib }: MarksRouteDeps): void {
  // ── 标注 ───────────────────────────────────────────────────────────────
  app.put('/api/v1/marks', async (req, reply) => {
    const body = (req.body ?? {}) as { items?: MarkInput[] };
    const items = Array.isArray(body.items) ? body.items.filter((i) => i && typeof i.id === 'string') : [];
    if (!items.length) return reply.code(400).send({ error: 'items 不能为空' });
    if (hasInvalidStars(items)) return reply.code(400).send({ error: 'stars 只能是 0–5 的整数' });
    const info = infoOf(req);
    const by = info.via === 'bearer' ? `ai:${info.token?.label ?? 'token'}` : info.via === 'link' ? 'link:external' : 'me';
    const results = await lib.applyMarks(items.map((i) => ({ ...i, by: i.by ?? by, channel: i.channel ?? (info.via === 'link' ? 'link' : info.via === 'bearer' ? 'api' : 'inapp') })));
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) return reply.code(409).send({ error: failed[0]?.error ?? '全部失败', results });
    return { results };
  });

  app.get('/api/v1/marks/history', async (req) => {
    const q = req.query as { photoId?: string; limit?: string; jobId?: string };
    // 三种切法：某张照片的来龙去脉 / 最近若干条 / 某个任务写了什么（对账用）
    return { items: lib.history(q.limit ? Number(q.limit) : undefined, q.photoId, q.jobId) };
  });

  // ── 回收站 ─────────────────────────────────────────────────────────────
  // 待删是标记（原地不动），进这里是明确的二次动作：成对搬进照片旁的 `.trash/`，还能成对搬回来。
  app.get('/api/v1/trash', async () => ({ items: lib.trashEntries() }));

  app.post('/api/v1/trash', async (req, reply) => {
    const ids = idsOf(req.body);
    if (!ids.length) return reply.code(400).send({ error: 'ids 不能为空' });
    const res = await lib.moveToTrash(ids);
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });

  app.post('/api/v1/trash/restore', async (req, reply) => {
    const ids = idsOf(req.body);
    if (!ids.length) return reply.code(400).send({ error: 'ids 不能为空' });
    const res = await lib.restoreFromTrash(ids);
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });

  app.delete('/api/v1/trash', async (req, reply) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'true') return reply.code(400).send({ error: '真删不可恢复：要带 ?confirm=true' });
    const res = await lib.emptyTrash(idsOf(req.body));
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });
}
