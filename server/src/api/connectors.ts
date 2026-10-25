/**
 * 连接器管理 API（F09）。只放已认证的浏览器管理 session：
 * - 未设应用密码 → 403 PASSWORD_REQUIRED（不能在公开免认证状态管理/启用外传）；
 * - bearer / 链接 / 范围 token → 403 SESSION_REQUIRED；
 * - 写操作要求同源：Origin（或 Sec-Fetch-Site=same-origin）与 Host 一致，否则 403 CSRF_REJECTED。
 * 响应只含脱敏视图（secretConfigured），绝不回显 Secret 值。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConnectorConfigError, ConnectorConfigStore, sanitize } from '../connectors/config.ts';
import type { ConnectorRuntime } from '../connectors/runtime.ts';
import type { ConnectorInstanceConfig } from '../connectors/types.ts';

export interface ConnectorApiDeps {
  store: ConnectorConfigStore;
  runtime: ConnectorRuntime;
  authEnabled: () => boolean;
  /** 本次请求的凭据种类（session / bearer / link / annotate / disabled） */
  via: (req: FastifyRequest) => string;
  /** 被投递策略或活跃派发引用时返回 true（后续模块注入）；默认无引用 */
  isReferenced?: (connectorId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

const MAX_LIMIT = 100;
const PATCHABLE = new Set(['label', 'appId', 'secretEnv', 'tenantId', 'enabled', 'targets', 'creatorActorIds', 'creatorProjectIds']);

const err = (reply: FastifyReply, status: number, code: string, error: string) => reply.code(status).send({ error, code });

function configError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ConnectorConfigError) {
    // 只回代码与固定文案：校验细节可能夹带用户提交的原始值，这里不回显
    return err(reply, e.code === 'REVISION_CONFLICT' ? 409 : 400, e.code, e.code === 'REVISION_CONFLICT' ? '配置已被修改，请刷新后重试' : '连接器配置不合法');
  }
  throw e;
}

export function sameOrigin(req: FastifyRequest): boolean {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  return req.headers['sec-fetch-site'] === 'same-origin';
}

/** 外传管理面共用的门：须有应用密码、浏览器 session、写操作同源（连接器与投递策略共用） */
export function managementGuard(authEnabled: () => boolean, via: (req: FastifyRequest) => string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authEnabled()) return err(reply, 403, 'PASSWORD_REQUIRED', '先设置应用密码才能管理外传');
    if (via(req) !== 'session') return err(reply, 403, 'SESSION_REQUIRED', '外传只能在已登录的浏览器里管理');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return err(reply, 403, 'CSRF_REJECTED', '跨站请求被拒绝');
  };
}

export function revisionOf(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

export function registerConnectorRoutes(app: FastifyInstance, deps: ConnectorApiDeps): void {
  const env = deps.env ?? process.env;
  const view = (i: ConnectorInstanceConfig) => ({ ...sanitize(i, env), status: deps.runtime.status(i.id) });
  const find = (id: string) => deps.store.current.instances.find((i) => i.id === id);

  app.register(async (scope) => {
    scope.addHook('preHandler', managementGuard(deps.authEnabled, deps.via));

    scope.get('/api/v1/connectors', async (req, reply) => {
      const q = req.query as { limit?: string; cursor?: string };
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return err(reply, 400, 'INVALID_LIMIT', `limit 须为 1–${MAX_LIMIT}`);
      if (!Number.isInteger(start) || start < 0) return err(reply, 400, 'INVALID_CURSOR', 'cursor 不合法');
      const all = deps.store.current.instances;
      const page = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return { revision: deps.store.current.revision, items: page.map(view), nextCursor: next };
    });

    scope.post('/api/v1/connectors', async (req, reply) => {
      const body = (req.body ?? {}) as { expectedRevision?: unknown; instance?: unknown };
      const rev = revisionOf(body.expectedRevision);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      try {
        const doc = deps.store.create(body.instance, rev);
        const created = doc.instances.at(-1)!;
        return reply.code(201).send({ revision: doc.revision, item: view(created) });
      } catch (e) { return configError(reply, e); }
    });

    scope.patch('/api/v1/connectors/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rev = revisionOf(body['expectedRevision']);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      const cur = find(id);
      if (!cur) return err(reply, 404, 'CONNECTOR_NOT_FOUND', '没有这个连接器');
      const patch = (body['patch'] ?? {}) as Record<string, unknown>;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err(reply, 400, 'INVALID_FIELD', 'patch 须为对象');
      for (const k of Object.keys(patch)) if (!PATCHABLE.has(k)) return err(reply, 400, k === 'secret' || k === 'appSecret' ? 'RAW_SECRET_FORBIDDEN' : 'UNKNOWN_FIELD', '连接器配置不合法');
      const next = { ...cur, ...patch };
      try {
        const doc = deps.store.replace(deps.store.current.instances.map((i) => (i.id === id ? next : i)), rev);
        await deps.runtime.sync();
        return { revision: doc.revision, item: view(find(id)!) };
      } catch (e) { return configError(reply, e); }
    });

    scope.delete('/api/v1/connectors/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const rev = revisionOf((req.query as { expectedRevision?: string }).expectedRevision);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      const cur = find(id);
      if (!cur) return err(reply, 404, 'CONNECTOR_NOT_FOUND', '没有这个连接器');
      if (cur.enabled) return err(reply, 409, 'CONNECTOR_ENABLED', '先停用再删除');
      if (deps.isReferenced?.(id)) return err(reply, 409, 'CONNECTOR_REFERENCED', '仍被投递策略或派发引用，先解绑');
      try {
        const doc = deps.store.replace(deps.store.current.instances.filter((i) => i.id !== id), rev);
        await deps.runtime.sync();
        return { revision: doc.revision };
      } catch (e) { return configError(reply, e); }
    });

    scope.post('/api/v1/connectors/:id/test', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!find(id)) return err(reply, 404, 'CONNECTOR_NOT_FOUND', '没有这个连接器');
      // 只验证凭据/连接，不发送任何消息（CC-07）
      return deps.runtime.test(id);
    });

    scope.get('/api/v1/connectors/:id/targets', async (req, reply) => {
      const { id } = req.params as { id: string };
      const cur = find(id);
      if (!cur) return err(reply, 404, 'CONNECTOR_NOT_FOUND', '没有这个连接器');
      return { items: cur.targets };
    });
  });
}
