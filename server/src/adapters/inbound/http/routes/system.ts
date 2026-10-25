/** 服务自身：健康、能力清单、会话 */

import type { FastifyInstance } from 'fastify';
import type { ConnectorRegistry } from '../../../../application/connectors/registry.ts';
import type { ConnectorRuntime } from '../../../../application/connectors/runtime.ts';
import { getHandler, jobKinds } from '../../../../application/jobs/registry.ts';
import { listChannels } from '../../../../domain/jobs/channels.ts';
import type { Config } from '../../../outbound/config-file.ts';
import type { ConnectorConfigStore } from '../../../outbound/fs/connector-config-store.ts';
import type { Library } from '../../../outbound/fs/library.ts';
import type { Auth } from '../auth.ts';
import type { LoginLimiter } from '../login-limiter.ts';
import { authed, COOKIE } from '../request.ts';

const VERSION = '0.1.0';

export interface SystemRouteDeps {
  readonly cfg: Config;
  readonly auth: Auth;
  readonly lib: Library;
  readonly connectorRegistry: ConnectorRegistry;
  readonly connectorStore: ConnectorConfigStore;
  readonly connectorRuntime: ConnectorRuntime;
  readonly loginLimiter: LoginLimiter;
}

export function registerSystemRoutes(app: FastifyInstance, { cfg, auth, lib, connectorRegistry, connectorStore, connectorRuntime, loginLimiter }: SystemRouteDeps): void {
  app.get('/api/v1/health', async (req) => ({
    ok: true,
    version: VERSION,
    roots: cfg.roots.map((r) => r.id),
    authRequired: auth.enabled,
    // 「后端要不要密码」与「你这次带没带有效凭据」是两件事：前端靠前者决定显不显示登录页，
    // 靠后者判断刚登完的这次/session 有没有真的生效（少了它会把登录成功后的人又踢回登录页）。
    authenticated: !auth.enabled || authed.has(req),
  }));

  app.get('/api/v1/capabilities', async () => ({
    // 注册表投影：新加一个 jobs/<kind>.ts 就会出现在这里，前端零改动
    jobs: jobKinds().flatMap((kind) => {
      const h = getHandler(kind);
      return h ? [{ kind: h.kind, label: h.label, params: h.params, sideEffect: h.sideEffect, undoable: h.undoable }] : [];
    }),
    channels: listChannels(),
    executors: [
      // 声明将来 push 形态（我们调模型）打算支持的执行者；**当前一个都还没实现** ——
      // capabilities 的消费者（agent）靠 status 分辨，别把占位当成可用能力。
      { kind: 'ollama', model: '', local: true, status: 'planned' },
      { kind: 'openai', model: '', local: false, status: 'planned' },
      { kind: 'anthropic', model: '', local: false, status: 'planned' },
    ],
    library: lib.status,
    // 连接器能力摘要：只反映真实注册/启用/运行状态，不含配置细节与凭据
    connectors: {
      adapters: (['feishu'] as const).filter((k) => connectorRegistry.factory(k) !== undefined),
      instances: connectorStore.current.instances.map((i) => ({ id: i.id, kind: i.kind, enabled: i.enabled, state: connectorRuntime.status(i.id).state })),
    },
    notes: '任务层已开（POST /jobs 先 plan 再 apply；批注回流走 POST /jobs/{id}/inbound）；通道 v1 只有内置 inapp。AI 接入用 pull 形态：Bearer token + GET /photos + PUT /marks（见 docs/agent-access.md）；executors 均为 planned（push 未实现）。',
  }));

  // ── 会话 ───────────────────────────────────────────────────────────────
  const cookieSecure = (req: { protocol: string }) => cfg.cookieSecure === 'always' || (cfg.cookieSecure !== 'never' && req.protocol === 'https');
  app.post('/api/v1/session', async (req, reply) => {
    const ip = req.ip;
    const wait = loginLimiter.blockedFor(ip);
    if (wait > 0) return reply.code(429).header('retry-after', String(Math.ceil(wait / 1000))).send({ error: '尝试过于频繁，请稍后再试', code: 'TOO_MANY_ATTEMPTS', retryAfterMs: wait });
    const body = (req.body ?? {}) as { password?: string };
    if (!auth.checkPassword(body.password ?? '')) {
      const next = loginLimiter.fail(ip);
      if (next > 0) reply.header('retry-after', String(Math.ceil(next / 1000)));
      return reply.code(401).send({ error: '密码不对' });
    }
    loginLimiter.success(ip);
    reply.setCookie(COOKIE, auth.sessionCookie(), { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), maxAge: 30 * 24 * 3600 });
    return reply.code(204).send();
  });

  app.delete('/api/v1/session', async (req, reply) => {
    // 登出吊销全部已签发会话（代数 +1）；仅已登录者可触发，免得匿名请求把主人踢下线
    if (auth.enabled && auth.checkSession(req.cookies?.[COOKIE])) auth.revokeSessions();
    reply.clearCookie(COOKIE, { path: '/', secure: cookieSecure(req) });
    return reply.code(204).send();
  });
}
