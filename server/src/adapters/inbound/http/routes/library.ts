/** 目录与照片：根、目录浏览、照片列表、缩略图与原始文件、重扫 */

import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseSelectionQuery, selectionFromLegacyFilter } from '../../../../domain/selection.ts';
import { expandHome } from '../../../outbound/config-file.ts';
import type { Library } from '../../../outbound/fs/library.ts';
import { PreviewUnavailable } from '../../../outbound/thumbs.ts';

/** 「选择目录」接口的最小目录项 */
type DirEntry = { name: string; path: string };

export interface LibraryRouteDeps {
  readonly lib: Library;
}

export function registerLibraryRoutes(app: FastifyInstance, { lib }: LibraryRouteDeps): void {
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
    const q = req.query as { dir?: string; cursor?: string; limit?: string; sel?: string; filter?: string; recursive?: string };
    if (!q.dir) return reply.code(400).send({ error: '要带 dir（虚拟路径 /<rootId>/子目录 或真实磁盘路径）' });
    const parsed = q.sel ? parseSelectionQuery(q.sel) : null;
    if (parsed?.unknown.length) return reply.code(400).send({ error: `sel 里有认不出的条件：${parsed.unknown.slice(0, 3).join(', ').slice(0, 120)}` });
    const selection = parsed ? parsed.selection : q.filter && q.filter !== 'all' ? selectionFromLegacyFilter(q.filter) : {};
    const page = lib.listPhotos({
      dir: q.dir,
      selection,
      cursor: q.cursor ?? null,
      limit: q.limit ? Number(q.limit) : undefined,
      recursive: q.recursive === '1' || q.recursive === 'true',
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

  // 让用户手动触发一次重扫（外部工具改了盘上的照片之后）。force：连失联的挂载也立刻重试一次
  app.post('/api/v1/scan', async (_req, reply) => {
    const r = lib.requestRefresh({ force: true });
    return reply.code(202).send(r.started ? { started: true } : { started: false, queued: r.queued, reason: r.queued ? '已有扫描在进行中：已排队补扫一次' : '已有扫描在进行中' });
  });
}
