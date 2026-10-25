/** AI / CLI 用的长期 token：只能在已登录的浏览器里签发、列出与撤销（token 不能再签 token）。 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth.ts';

/** 目前只有一种权限：完整 API 访问。新增 scope 必须先在这里登记并在鉴权里落实。 */
export const TOKEN_SCOPES = ['full'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
const MAX_LABEL = 100;

export interface TokenRouteDeps {
  readonly auth: Auth;
  readonly via: (req: FastifyRequest) => string;
}

export function registerTokenRoutes(app: FastifyInstance, { auth, via }: TokenRouteDeps): void {
  app.register(async (scope) => {
    // 会话 cookie 是 SameSite=lax，跨站 POST/DELETE 带不上，这里只需确认凭据类型
    scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!auth.enabled) return;
      if (via(req) !== 'session') return reply.code(403).send({ error: 'API token 只能在已登录的浏览器里管理', code: 'SESSION_REQUIRED' });
    });

    scope.get('/api/v1/api-tokens', async () => ({ tokens: auth.listTokens() }));

    scope.post('/api/v1/api-tokens', async (req, reply) => {
      const body = (req.body ?? {}) as { label?: unknown; scope?: unknown };
      const label = body.label === undefined ? '未命名' : body.label;
      if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL) return reply.code(400).send({ error: `label 须为 1–${MAX_LABEL} 个字符`, code: 'INVALID_LABEL' });
      const tokenScope = body.scope ?? 'full';
      if (!TOKEN_SCOPES.includes(tokenScope as TokenScope)) return reply.code(400).send({ error: `scope 只能是 ${TOKEN_SCOPES.join(' / ')}`, code: 'INVALID_SCOPE' });
      const { token, meta } = auth.issueToken(label.trim(), tokenScope as TokenScope);
      const link = auth.issueLinkToken(meta.id);
      return reply.code(201).send({
        token,
        ...meta,
        // 图像加载器（agent / 模型服务商）带不上自定义 header，所以缩略图 URL 自带凭据：
        // 把 {id} 换成照片 id、{size} 换 512/2048。linkToken 绑在这条 API token 上，撤销即失效。
        linkToken: link.token,
        linkExpiresAt: link.expiresAt,
        thumbUrlTemplate: `/api/v1/photos/{id}/thumb?size={size}&t=${link.token}`,
        note: '明文只出现这一次；以后请求带 Authorization: Bearer <token>。缩略图用 thumbUrlTemplate（把 {id}/{size} 填上），不用带 header。',
      });
    });

    scope.delete('/api/v1/api-tokens', async (req, reply) => {
      const q = req.query as { id?: string };
      if (!q.id) return reply.code(400).send({ error: '要带 ?id=' });
      if (!auth.revokeToken(q.id)) return reply.code(404).send({ error: '没这个 token' });
      return reply.code(204).send();
    });
  });
}
