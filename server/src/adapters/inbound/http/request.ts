/** 请求上下文：凭据来源、操作者与入参的最小解析（各路由共用） */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { JobError, type JobProblem } from '../../../domain/jobs/job.ts';
import type { InboundInput } from '../../../application/jobs/registry.ts';
import type { ApiTokenMeta } from './auth.ts';

export const COOKIE = 'artworks_session';

export interface AuthInfo {
  via: 'disabled' | 'session' | 'bearer' | 'link' | 'annotate';
  token?: ApiTokenMeta;
  /** `via='annotate'`：任务范围 token（批注链接）里的任务 id 与批注人 */
  jobId?: string;
  alias?: string;
}

export const authInfo = new WeakMap<FastifyRequest, AuthInfo>();
/** 这一次请求带了有效凭据吗（`/health` 要用它回答「我登进去了吗」） */
export const authed = new WeakSet<FastifyRequest>();

export function infoOf(req: FastifyRequest): AuthInfo {
  return authInfo.get(req) ?? { via: 'disabled' };
}


/** 批量接口的入参：`{ ids: [...] }`（缺/空一律当成空数组，由调用方决定怎么拒绝） */
export function idsOf(body: unknown): string[] {
  const raw = (body ?? {}) as { ids?: unknown };
  return Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/**
 * 回流项：手写校验（这个仓没有 Fastify schema）。`by` 不在这里 —— 它由凭据推（见 POST /jobs/:id/inbound）。
 */
export function inboundItemsOf(body: unknown): InboundInput[] {
  const raw = (body ?? {}) as { items?: unknown };
  if (!Array.isArray(raw.items)) return [];
  const out: InboundInput[] = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object') continue;
    const it = entry as Record<string, unknown>;
    if (typeof it['photoId'] !== 'string' || !it['photoId']) continue;
    const item: InboundInput = { photoId: it['photoId'] };
    if (typeof it['stars'] === 'number' && Number.isFinite(it['stars'])) {
      item.stars = Math.max(0, Math.min(5, Math.round(it['stars'])));
    }
    if (typeof it['del'] === 'boolean') item.del = it['del'];
    if (typeof it['at'] === 'string' && it['at']) item.at = it['at'];
    if (typeof it['clientRef'] === 'string' && it['clientRef']) item.clientRef = it['clientRef'];
    out.push(item);
  }
  return out;
}

/** 这次请求是谁在操作（标注的 `by` 来源）：会话/免认证 = 本人，bearer = AI，链接 = 外部 */
export function byOf(req: FastifyRequest): string {
  const info = infoOf(req);
  if (info.via === 'bearer') return `ai:${info.token?.label ?? 'token'}`;
  if (info.via === 'link') return 'link:external';
  if (info.via === 'annotate') return `link:${info.alias ?? 'external'}`;
  return 'me';
}

/** 任务层的业务错误对 HTTP：语义在 core/jobs.ts（JobError.code），映射只在这里 */
export function jobError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof JobError) {
    const status = { invalid: 400, notfound: 404, conflict: 409, forbidden: 403 }[err.code];
    const body: { error: string; detail?: { problems: JobProblem[] } } = { error: err.message };
    if (err.problems?.length) body.detail = { problems: err.problems };
    return reply.code(status).send(body);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: msg });
}

/** 组合根注入（F21）：平台适配器工厂由入口传入；测试注入假 SDK，默认不注册任何适配器（零外网） */
