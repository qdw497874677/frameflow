/** 任务层与出站通道（见 docs/core-model.md §7） */

import type { FastifyInstance } from 'fastify';
import { hasInvalidStars } from '../../../../domain/marks.ts';
import { jobKinds } from '../../../../application/jobs/registry.ts';
import type { JobsService } from '../../../../application/jobs/service.ts';
import { listChannels } from '../../../../domain/jobs/channels.ts';
import { confirmationSummary, type Job } from '../../../../domain/jobs/job.ts';
import type { Selection } from '../../../../domain/selection.ts';
import type { Library } from '../../../outbound/fs/library.ts';
import { byOf, inboundItemsOf, infoOf, jobError } from '../request.ts';

export interface JobRouteDeps {
  readonly jobs: JobsService;
  readonly lib: Library;
}

export function registerJobRoutes(app: FastifyInstance, { jobs, lib }: JobRouteDeps): void {
  // ── 任务层（见 docs/core-model.md §7 与 server/src/jobs/）────────────────
  // 一个任务 = 「把一批照片交给某个 kind 去办」。先 `mode:'plan'` 把选择集展开成 items 快照给你看
  // （不落库、不签发任何东西），人点头了再 `mode:'apply'` 落库、入队、执行。

  app.post('/api/v1/jobs', async (req, reply) => {
    const body = (req.body ?? {}) as { kind?: unknown; selection?: unknown; params?: unknown; mode?: unknown };
    if (body.mode !== undefined && body.mode !== 'plan' && body.mode !== 'apply') {
      return reply.code(400).send({ error: `mode 只能是 plan / apply（收到 ${JSON.stringify(body.mode)}）` });
    }
    if (typeof body.kind !== 'string' || !body.kind.trim()) {
      return reply.code(400).send({ error: `要带 kind（任务类型）。可用：${jobKinds().join(' / ')}` });
    }
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
    try {
      const job = await jobs.create({
        kind: body.kind.trim(),
        selection: (body.selection ?? {}) as Selection,
        params,
        mode: body.mode === 'apply' ? 'apply' : 'plan',
        by: byOf(req),
        // 范围 token 绑在签发它的 API token 上（会话/免认证签发时为 null）：撤销那条 token 链接即失效
        tokenId: infoOf(req).token?.id ?? null,
      });
      return reply.code(201).send(job);
    } catch (err) {
      return jobError(reply, err);
    }
  });

  // F27：显式确认任务附带兼容可选的确认进度（旧任务不带，progress 语义不变）
  const withConfirmation = (j: Job) => {
    const c = confirmationSummary(j, (pid) => lib.markVersion(pid) !== null);
    return c ? { ...j, confirmation: c } : j;
  };
  app.get('/api/v1/jobs', async (req) => {
    const q = req.query as { state?: string; limit?: string };
    return { items: jobs.list({ state: q.state, limit: q.limit ? Number(q.limit) : undefined }).map(withConfirmation) };
  });

  app.get('/api/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return withConfirmation(jobs.get(id));
    } catch (err) {
      return jobError(reply, err);
    }
  });

  // 增量轮询用：since 之后的事件 + 下次带上的游标 nextSince（seq 全局单调）
  app.get('/api/v1/jobs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; limit?: string };
    try {
      return jobs.events(id, { since: q.since ? Number(q.since) : undefined, limit: q.limit ? Number(q.limit) : undefined });
    } catch (err) {
      return jobError(reply, err);
    }
  });

  // 外部批注的回流口：批注人带着任务范围 token（`?t=`）来，免登录。
  // `by` 由凭据推（link:<批注人>），请求体里就算带了也不采信；只能写这个任务 items 里的照片。
  app.post('/api/v1/jobs/:id/inbound', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (hasInvalidStars((req.body as { items?: unknown } | null)?.items)) return reply.code(400).send({ error: 'stars 只能是 0–5 的整数' });
    const items = inboundItemsOf(req.body);
    if (!items.length) return reply.code(400).send({ error: 'items 不能为空：每项至少要有 photoId' });
    const info = infoOf(req);
    if (info.via === 'annotate' && info.jobId !== id) return reply.code(403).send({ error: '这个批注链接不是给这个任务的' });
    try {
      return { results: await jobs.inbound(id, items, byOf(req)) };
    } catch (err) {
      return jobError(reply, err);
    }
  });

  app.post('/api/v1/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await jobs.cancel(id);
    } catch (err) {
      return jobError(reply, err);
    }
  });

  // 撤销：只有 reversible 的任务能撤（否则 409）。annotate 是用 marks.jsonl 里本任务写下的 from 回滚。
  app.post('/api/v1/jobs/:id/undo', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await jobs.undo(id);
    } catch (err) {
      return jobError(reply, err);
    }
  });

  // ── 出站通道（回流不走这里，见 jobs/channels.ts）───────────────────────
  app.get('/api/v1/channels', async () => ({ items: listChannels() }));
}
