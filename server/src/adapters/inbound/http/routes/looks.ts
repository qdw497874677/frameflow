/** 滤镜风格：列表 + 原始 .cube（浏览器 WebGL2 预览与服务端导出读同一份 LUT）+ 胶片引擎状态 */
import type { FastifyInstance } from 'fastify';
import type { Look } from '../../../../domain/grading/recipe.ts';

export interface LookCatalog {
  /** 带来源：`cube` = 内置 .cube，`film` = 光谱胶片引擎烘焙 */
  entries(): Array<Look & { kind: string }>;
  /** .cube 文本；没这个风格 = null；有但暂时拿不到（引擎挂了且无缓存）= 'unavailable' */
  cubeText(id: string): Promise<string | null | 'unavailable'>;
  filmStatus(): Record<string, unknown>;
}

const CUBE_LICENSE = 'CC BY-SA 4.0（RawTherapee Film Simulation，Pat David / Pavlov Dmitry / Michael Ezra），见 server/assets/looks/NOTICE';
const FILM_NOTE = 'film 类风格由 FrameFlow 光谱胶片引擎从厂商公开数据表实时计算（非官方），来源见 engine/PROVENANCE.md';

export function registerLookRoutes(app: FastifyInstance, { looks }: { readonly looks: LookCatalog }): void {
  app.get('/api/v1/looks', async () => {
    const items = looks.entries().map((l) => ({ ...l, cube: `/api/v1/looks/${l.id}.cube` }));
    return { items, license: items.some((l) => l.kind === 'film') ? `${CUBE_LICENSE}；${FILM_NOTE}` : CUBE_LICENSE };
  });

  app.get('/api/v1/looks/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const m = /^([a-z0-9]+)\.cube$/.exec(file);
    const text = m ? await looks.cubeText(m[1]!) : null;
    if (text === null) return reply.code(404).send({ error: `没这个风格：${file}` });
    if (text === 'unavailable') return reply.code(503).send({ error: `胶片引擎暂时不可用，也没有缓存：${file}` });
    return reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(text);
  });

  app.get('/api/v1/film/status', async () => looks.filmStatus());
}
