/** AI / CLI 用的长期 token */

import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth.ts';

export interface TokenRouteDeps {
  readonly auth: Auth;
}

export function registerTokenRoutes(app: FastifyInstance, { auth }: TokenRouteDeps): void {
  app.get('/api/v1/api-tokens', async () => ({ tokens: auth.listTokens() }));

  app.post('/api/v1/api-tokens', async (req, reply) => {
    const body = (req.body ?? {}) as { label?: string; scope?: string };
    const { token, meta } = auth.issueToken(body.label ?? '未命名', body.scope ?? 'full');
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

  app.delete('/api/v1/api-tokens', async (req, reply) => {
    const q = req.query as { id?: string };
    if (!q.id) return reply.code(400).send({ error: '要带 ?id=' });
    if (!auth.revokeToken(q.id)) return reply.code(404).send({ error: '没这个 token' });
    return reply.code(204).send();
  });
}
