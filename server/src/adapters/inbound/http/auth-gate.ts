/** 认证门：一条密码，三种凭据（见 auth.ts）。先认来源（永远做），再拦请求（认证开着才做） */

import type { FastifyInstance } from 'fastify';
import type { JobsService } from '../../../application/jobs/service.ts';
import type { Auth } from './auth.ts';
import { authed, authInfo, COOKIE } from './request.ts';

export function registerAuthGate(app: FastifyInstance, auth: Auth, jobs: JobsService): void {
  app.addHook('onRequest', async (req, reply) => {
    // 两件事分开：**认来源**（谁在操作，永远做）与**拦请求**（认证开着才做）
    const path = req.url.split('?')[0] ?? '';
    const q = req.query as Record<string, string> | undefined;
    const thumbMatch = /^\/api\/v1\/photos\/[^/]+\/thumb$/.test(path);
    // `?t=` 只在三条路由上算凭据：读缩略图、读**自己那一个**任务（批注页刷新后要能读回 items），
    // 以及在批注链接里往任务送回结果
    const inboundMatch = /^\/api\/v1\/jobs\/[^/]+\/inbound$/.test(path);
    const jobDetailMatch = /^\/api\/v1\/jobs\/[^/]+$/.test(path);
    const who = auth.identify({
      cookie: req.cookies?.[COOKIE],
      authorization: req.headers.authorization,
      // 两种 `?t=` 按路由分开：缩略图两条都收（只读链接 + 任务范围 token），回流**只收**任务范围 token
      linkToken: thumbMatch ? q?.['t'] : undefined,
      rangeToken: thumbMatch || inboundMatch || jobDetailMatch ? q?.['t'] : undefined,
    });
    authInfo.set(req, who ?? { via: 'disabled' });
    if (who) authed.add(req);
    // 任务范围 token（批注链接）的作用域：只对它那个任务有效 —— 缩略图只看任务 items 里的照片，
    // 详情只读它自己那一个任务（列表/事件/取消/撤销一律不放行），回流只能回自己的任务；
    // 任务被取消/删掉则整条链接失效。别的路由一律不放行。
    if (who?.via === 'annotate') {
      const jobId = who.jobId ?? '';
      if (!jobs.rangeTokenValid(jobId)) return reply.code(403).send({ error: '这个批注链接已经失效了（任务已取消或没了）' });
      // 作用域只看路径与方法：详情只读（GET）、回流只写（POST）。今天就算不判方法也
      // 越不了权（这两条路由只有一个方法），但将来给 /jobs/{id} 加 PUT/DELETE 时就晚了。
      let seg = '';
      try {
        seg = decodeURIComponent(path.split('/')[4] ?? '');
      } catch {
        // 畸形百分号编码（`/photos/%/thumb`）：不泄漏、也不让它冒成 500
        return reply.code(404).send({ error: '这个批注链接只对它那个任务有效' });
      }
      const inScope =
        thumbMatch && req.method === 'GET'
          ? jobs.hasItem(jobId, seg)
          : jobDetailMatch && req.method === 'GET'
            ? seg === jobId
            : inboundMatch && req.method === 'POST' && seg === jobId;
      if (!inScope) return reply.code(404).send({ error: '这个批注链接只对它那个任务有效' });
      return;
    }
    if (!auth.enabled) return; // 免认证：一律放行，但来源已经认过了
    // 缩略图链接是只读凭据：认证开着时不能拿它去写回流（只有范围 token / Bearer / 会话能写）
    if (inboundMatch && who?.via === 'link') {
      return reply.code(403).send({ error: '这是缩略图链接，只能看；要写标注请用任务签发的批注链接' });
    }
    // 静态前端（'/'、/assets/*、index.html 回落）不受认证门保护：应用壳里没有数据，
    // 数据全在 /api/ 后面。把壳也锁上的话，浏览器连登录页都拿不到（只能看到 401 的 JSON）。
    if (!path.startsWith('/api/')) return;
    if (path === '/api/v1/health' || path === '/api/v1/session') return;
    if (who) return;
    return reply.code(401).send({ error: '未认证：先 POST /api/v1/session，或带 Bearer token' });
  });
}
