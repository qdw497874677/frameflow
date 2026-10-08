/**
 * HTTP 层：把 contracts/openapi.yaml 铺成实际的路由。
 * 这里**不放业务逻辑** —— 只做参数解析、认证、DTO 组装与流式输出；一切判断都在 core/ 里。
 */

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream, existsSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expandHome, type Config } from '../config.ts';
import { JobError, JobsStore, type JobProblem } from '../core/jobs.ts';
import type { Library } from '../core/library.ts';
import type { MarkInput } from '../core/marks.ts';
import { selectionFromLegacyFilter, selectionFromQuery, type Selection } from '../core/selection.ts';
import { PreviewUnavailable } from '../core/thumbs.ts';
import { listChannels } from '../jobs/channels.ts';
import { getHandler, jobKinds, registry } from '../jobs/registry.ts';
import type { InboundInput } from '../jobs/registry.ts';
import { JobsService } from '../jobs/service.ts';
import { Auth, type ApiTokenMeta } from './auth.ts';

const VERSION = '0.1.0';
const COOKIE = 'artworks_session';

/** 「选择目录」接口的最小目录项 */
type DirEntry = { name: string; path: string };

interface AuthInfo {
  via: 'disabled' | 'session' | 'bearer' | 'link' | 'annotate';
  token?: ApiTokenMeta;
  /** `via='annotate'`：任务范围 token（批注链接）里的任务 id 与批注人 */
  jobId?: string;
  alias?: string;
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

/**
 * 回流项：手写校验（这个仓没有 Fastify schema）。`by` 不在这里 —— 它由凭据推（见 POST /jobs/:id/inbound）。
 */
function inboundItemsOf(body: unknown): InboundInput[] {
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
function byOf(req: FastifyRequest): string {
  const info = infoOf(req);
  if (info.via === 'bearer') return `ai:${info.token?.label ?? 'token'}`;
  if (info.via === 'link') return 'link:external';
  if (info.via === 'annotate') return `link:${info.alias ?? 'external'}`;
  return 'me';
}

/** 任务层的业务错误对 HTTP：语义在 core/jobs.ts（JobError.code），映射只在这里 */
function jobError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof JobError) {
    const status = { invalid: 400, notfound: 404, conflict: 409, forbidden: 403 }[err.code];
    const body: { error: string; detail?: { problems: JobProblem[] } } = { error: err.message };
    if (err.problems?.length) body.detail = { problems: err.problems };
    return reply.code(status).send(body);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: msg });
}

export async function buildServer(cfg: Config, lib: Library): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel }, bodyLimit: 8 * 1024 * 1024 });
  const auth = new Auth(cfg.dataDir, cfg.password);
  // 任务层：磁盘上两份追加日志（core/jobs.ts），执行由进程内一个队列兜（jobs/service.ts）。
  // 签发批注链接的能力在这里注入，handler 自己不碰 auth。
  const jobs = new JobsService(new JobsStore(cfg.dataDir), registry, {
    lib,
    signRangeToken: (jobId, alias, tokenId) => auth.issueRangeToken(jobId, alias, tokenId),
  });
  await app.register(cookie);

  // ── 认证：一条密码，三种凭据（见 api/auth.ts）──────────────────────────
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
    // 注册表投影：新加一个 jobs/<kind>.ts 就会出现在这里，前端零改动
    jobs: jobKinds().flatMap((kind) => {
      const h = getHandler(kind);
      return h ? [{ kind: h.kind, label: h.label, params: h.params, sideEffect: h.sideEffect, undoable: h.undoable }] : [];
    }),
    channels: listChannels(),
    executors: [
      { kind: 'ollama', model: '', local: true },
      { kind: 'openai', model: '', local: false },
      { kind: 'anthropic', model: '', local: false },
    ],
    library: lib.status,
    notes: '任务层已开（POST /jobs 先 plan 再 apply；批注回流走 POST /jobs/{id}/inbound）；通道 v1 只有内置 inapp。AI 客户端现在就能用 GET /photos + PUT /marks 取活干。',
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

  // 「选择目录」的下钻数据源：真实文件系统，只列目录（含指向目录的符号链接，如 ~/nfs）。
  app.get('/api/v1/fs/browse', async (req, reply) => {
    const q = (req.query as { path?: string }).path;
    const target = q?.trim() ? resolve(expandHome(q.trim())) : homedir();
    let entries: Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: `读不了这个目录：${target} —— ${msg}` });
    }
    const dirs = (
      await Promise.all(
        entries
          .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
          .map(async (e): Promise<DirEntry | null> => {
            const p = join(target, e.name);
            if (e.isDirectory()) return { name: e.name, path: p };
            try {
              return (await stat(p)).isDirectory() ? { name: e.name, path: p } : null; // 符号链接指向目录才算
            } catch {
              return null; // 悬挂链接（gvfs 挂载断开时会这样）跳过，别让一个坏链接挂掉整个浏览
            }
          }),
      )
    )
      .filter((d): d is DirEntry => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const parent = dirname(target) === target ? null : dirname(target);
    return { path: target, parent, dirs };
  });

  // 添加项目：路径探不到 → 404；已在列表 → 400。成功 201 且回整棵 Root（前端马上刷新侧边栏）。
  app.post('/api/v1/roots', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; label?: string };
    if (!body.path?.trim()) return reply.code(400).send({ error: '要带 path（磁盘绝对路径）' });
    try {
      const root = await lib.addRoot({ path: body.path, label: body.label });
      return reply.code(201).send({ root });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const notThere = msg.includes('访问不到');
      return reply.code(notThere ? 404 : 400).send({ error: msg });
    }
  });

  // 改根显示名 / 移除根。移除只解除映射：盘上文件一个不动，重新添加即找回。
  app.patch('/api/v1/roots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { label?: string };
    try {
      const root = lib.renameRoot(id, body.label ?? '');
      return reply.send({ root });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(msg.includes('没有这个项目') ? 404 : 400).send({ error: msg });
    }
  });

  app.delete('/api/v1/roots/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      lib.removeRoot(id);
      return reply.code(204).send();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(404).send({ error: msg });
    }
  });

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
    const q = req.query as { variant?: 'jpeg' | 'raw' | 'video' | 'auto' };
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

  app.get('/api/v1/jobs', async (req) => {
    const q = req.query as { state?: string; limit?: string };
    return { items: jobs.list({ state: q.state, limit: q.limit ? Number(q.limit) : undefined }) };
  });

  app.get('/api/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return jobs.get(id);
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

  // 让用户手动触发一次重扫（外部工具改了盘上的照片之后）。force：连失联的挂载也立刻重试一次
  app.post('/api/v1/scan', async (_req, reply) => {
    const r = lib.requestRefresh({ force: true });
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
