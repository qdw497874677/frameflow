/**
 * HTTP 层：把 contracts/openapi.yaml 铺成实际的路由。
 * 这里**不放业务逻辑** —— 只做参数解析、认证、DTO 组装与流式输出；一切判断都在 core/ 里。
 */

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Library } from '../core/library.ts';
import type { MarkInput } from '../core/marks.ts';
import { selectionFromLegacyFilter, selectionFromQuery } from '../core/selection.ts';
import { PreviewUnavailable } from '../core/thumbs.ts';
import { Auth, type ApiTokenMeta } from './auth.ts';

const VERSION = '0.1.0';
const COOKIE = 'artworks_session';

interface AuthInfo {
  via: 'disabled' | 'session' | 'bearer' | 'link';
  token?: ApiTokenMeta;
}

const authInfo = new WeakMap<FastifyRequest, AuthInfo>();
/** 这一次请求带了有效凭据吗（`/health` 要用它回答「我登进去了吗」） */
const authed = new WeakSet<FastifyRequest>();

function infoOf(req: FastifyRequest): AuthInfo {
  return authInfo.get(req) ?? { via: 'disabled' };
}

/** 批量接口的入参：`{ ids: [...] }`（缺/空一律当成空数组，由调用方决定怎么拒绝） */
function idsOf(body: unknown): string[] {
  const raw = (body ?? {}) as { ids?: unknown };
  return Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export async function buildServer(cfg: Config, lib: Library): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel }, bodyLimit: 8 * 1024 * 1024 });
  const auth = new Auth(cfg.dataDir, cfg.password);
  await app.register(cookie);

  // ── 认证：一条密码，三种凭据（见 api/auth.ts）──────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    // 两件事分开：**认来源**（谁在操作，永远做）与**拦请求**（认证开着才做）
    const path = req.url.split('?')[0] ?? '';
    const q = req.query as Record<string, string> | undefined;
    const thumbMatch = /^\/api\/v1\/photos\/([^/]+)\/thumb$/.exec(path);
    const who = auth.identify({
      cookie: req.cookies?.[COOKIE],
      authorization: req.headers.authorization,
      thumbToken: thumbMatch ? q?.['t'] : undefined,
      photoId: thumbMatch ? decodeURIComponent(thumbMatch[1] ?? '') : undefined,
    });
    authInfo.set(req, who ?? { via: 'disabled' });
    if (who) authed.add(req);
    if (!auth.enabled) return; // 免认证：一律放行，但来源已经认过了
    // 静态前端（'/'、/assets/*、index.html 回落）不受认证门保护：应用壳里没有数据，
    // 数据全在 /api/ 后面。把壳也锁上的话，浏览器连登录页都拿不到（只能看到 401 的 JSON）。
    if (!path.startsWith('/api/')) return;
    if (path === '/api/v1/health' || path === '/api/v1/session') return;
    if (who) return;
    return reply.code(401).send({ error: '未认证：先 POST /api/v1/session，或带 Bearer token' });
  });

  // ── 关于服务本身 ───────────────────────────────────────────────────────
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
    jobs: [],
    channels: [],
    executors: [
      { kind: 'ollama', model: '', local: true },
      { kind: 'openai', model: '', local: false },
      { kind: 'anthropic', model: '', local: false },
    ],
    library: lib.status,
    notes: '任务层与通道未实现（见 docs/core-model.md §11/§12）；AI 客户端现在就能用 GET /photos + PUT /marks 取活干。',
  }));

  // ── 会话 ───────────────────────────────────────────────────────────────
  app.post('/api/v1/session', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: string };
    if (!auth.checkPassword(body.password ?? '')) return reply.code(401).send({ error: '密码不对' });
    reply.setCookie(COOKIE, auth.sessionCookie(), { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 });
    return reply.code(204).send();
  });

  app.delete('/api/v1/session', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  // ── 目录与照片 ─────────────────────────────────────────────────────────
  app.get('/api/v1/roots', async () => ({ roots: lib.roots() }));

  app.get('/api/v1/folders', async (req, reply) => {
    const q = req.query as { path?: string };
    const listing = lib.listFolders(q.path);
    if (!listing) return reply.code(404).send({ error: `没这个目录：${q.path ?? ''}` });
    return listing;
  });

  app.get('/api/v1/photos', async (req, reply) => {
    const q = req.query as { dir?: string; cursor?: string; limit?: string; sel?: string; filter?: string };
    if (!q.dir) return reply.code(400).send({ error: '要带 dir（虚拟路径 /<rootId>/子目录 或真实磁盘路径）' });
    const selection = q.sel ? selectionFromQuery(q.sel) : q.filter && q.filter !== 'all' ? selectionFromLegacyFilter(q.filter) : {};
    const page = lib.listPhotos({
      dir: q.dir,
      selection,
      cursor: q.cursor ?? null,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    if (!page) return reply.code(404).send({ error: `没这个目录：${q.dir}` });
    return page;
  });

  // ── 缩略图与原始文件 ───────────────────────────────────────────────────
  app.get('/api/v1/photos/:id/thumb', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { size?: string };
    const size = Number(q.size) === 2048 ? 2048 : 512;
    const rec = lib.get(id);
    if (!rec) return reply.code(404).send({ error: '没这张照片（可能刚被移走）' });
    try {
      const { path, etag, source } = await lib.thumbs.thumb(rec, size);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply
        .header('content-type', 'image/jpeg')
        .header('etag', etag)
        .header('cache-control', 'private, max-age=604800, immutable')
        .header('x-preview-source', source)
        .send(createReadStream(path));
    } catch (err) {
      if (err instanceof PreviewUnavailable) return reply.code(422).send({ error: err.message });
      req.log.error({ err, id }, '缩略图生成失败');
      return reply.code(500).send({ error: `缩略图生成失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get('/api/v1/photos/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { variant?: 'jpeg' | 'raw' | 'auto' };
    const rec = lib.get(id);
    if (!rec) return reply.code(404).send({ error: '没这张照片' });
    const file = lib.absFile(rec, q.variant ?? 'auto');
    if (!file || !existsSync(file.path)) return reply.code(404).send({ error: '磁盘上没有这个文件' });
    const st = await stat(file.path);
    return reply
      .header('content-type', file.mime)
      .header('content-length', String(st.size))
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .send(createReadStream(file.path));
  });

  // ── 标注 ───────────────────────────────────────────────────────────────
  app.put('/api/v1/marks', async (req, reply) => {
    const body = (req.body ?? {}) as { items?: MarkInput[] };
    const items = Array.isArray(body.items) ? body.items.filter((i) => i && typeof i.id === 'string') : [];
    if (!items.length) return reply.code(400).send({ error: 'items 不能为空' });
    const info = infoOf(req);
    const by = info.via === 'bearer' ? `ai:${info.token?.label ?? 'token'}` : info.via === 'link' ? 'link:external' : 'me';
    const results = lib.applyMarks(items.map((i) => ({ ...i, by: i.by ?? by, channel: i.channel ?? (info.via === 'link' ? 'link' : info.via === 'bearer' ? 'api' : 'inapp') })));
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) return reply.code(409).send({ error: failed[0]?.error ?? '全部失败', results });
    return { results };
  });

  app.get('/api/v1/marks/history', async (req) => {
    const q = req.query as { photoId?: string; limit?: string };
    return { items: lib.history(q.limit ? Number(q.limit) : undefined, q.photoId) };
  });

  // ── 回收站 ─────────────────────────────────────────────────────────────
  // 待删是标记（原地不动），进这里是明确的二次动作：成对搬进照片旁的 `.trash/`，还能成对搬回来。
  app.get('/api/v1/trash', async () => ({ items: lib.trashEntries() }));

  app.post('/api/v1/trash', async (req, reply) => {
    const ids = idsOf(req.body);
    if (!ids.length) return reply.code(400).send({ error: 'ids 不能为空' });
    const res = lib.moveToTrash(ids);
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });

  app.post('/api/v1/trash/restore', async (req, reply) => {
    const ids = idsOf(req.body);
    if (!ids.length) return reply.code(400).send({ error: 'ids 不能为空' });
    const res = lib.restoreFromTrash(ids);
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });

  app.delete('/api/v1/trash', async (req, reply) => {
    const q = req.query as { confirm?: string };
    if (q.confirm !== 'true') return reply.code(400).send({ error: '真删不可恢复：要带 ?confirm=true' });
    const res = lib.emptyTrash(idsOf(req.body));
    return res.ok ? res : reply.code(409).send({ ...res, error: res.failed[0]?.error ?? '全部失败' });
  });

  // ── AI / CLI 用的长期 token ────────────────────────────────────────────
  app.get('/api/v1/api-tokens', async () => ({ items: auth.listTokens() }));

  app.post('/api/v1/api-tokens', async (req, reply) => {
    const body = (req.body ?? {}) as { label?: string; scope?: string };
    const { token, meta } = auth.issueToken(body.label ?? '未命名', body.scope ?? 'full');
    return reply.code(201).send({
      token,
      ...meta,
      note: '明文只出现这一次；以后请求带 Authorization: Bearer <token>。缩略图用 /photos/{id}/thumb?t=<签发时给的链接 token>。',
    });
  });

  app.delete('/api/v1/api-tokens', async (req, reply) => {
    const q = req.query as { id?: string };
    if (!q.id) return reply.code(400).send({ error: '要带 ?id=' });
    if (!auth.revokeToken(q.id)) return reply.code(404).send({ error: '没这个 token' });
    return reply.code(204).send();
  });

  // 让用户手动触发一次重扫（外部工具改了盘上的照片之后）
  app.post('/api/v1/scan', async (_req, reply) => {
    const r = lib.requestRefresh();
    return reply.code(202).send(r.started ? { started: true } : { started: false, queued: r.queued, reason: r.queued ? '已有扫描在进行中：已排队补扫一次' : '已有扫描在进行中' });
  });

  // ── 生产形态：顺手把 web/dist 端上来（一个进程、一个端口）─────────────
  const dist = join(process.cwd(), '..', 'web', 'dist');
  if (existsSync(join(dist, 'index.html'))) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'no such route' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

export type { FastifyReply, FastifyInstance };
