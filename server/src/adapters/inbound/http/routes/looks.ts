/** 滤镜风格：列表 + 原始 .cube（浏览器 WebGL2 预览与服务端导出读同一份 LUT）+ 胶片引擎状态 */
import type { FastifyInstance } from 'fastify';
import type { Look } from '../../../../domain/grading/recipe.ts';
import { filmEffectProblems, type FilmEffects } from '../../../../domain/grading/film.ts';

export interface LookCatalog {
  /** 带来源：`cube` = 内置 .cube，`film` = 光谱胶片引擎烘焙 */
  entries(): Array<Look & { kind: string }>;
  /** .cube 文本；没这个风格 = null；有但暂时拿不到（引擎挂了且无缓存）= 'unavailable' */
  cubeText(id: string): Promise<string | null | 'unavailable'>;
  filmStatus(): Record<string, unknown>;
  /** 100% 裁切预览（胶片开关打开才有）；null = 照片或风格不存在 */
  filmPreview?(req: { photoId: string; look: string; strength: number; film: FilmEffects; cx: number; cy: number; size: number }): Promise<{ jpeg: Uint8Array; ms: number } | null>;
}

const unit = (v: unknown, d: number) => (v === undefined ? d : typeof v === 'number' && v >= 0 && v <= 1 ? v : NaN);

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

  app.post('/api/v1/film/preview', async (req, reply) => {
    if (!looks.filmPreview) return reply.code(404).send({ error: '胶片模拟没打开（film.enabled）' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const film = b['film'] ?? {};
    const problems: string[] = [];
    if (typeof b['photoId'] !== 'string') problems.push('要带 photoId');
    if (typeof b['look'] !== 'string' || looks.entries().find((l) => l.id === b['look'])?.kind !== 'film') problems.push('look 要是光谱胶片风格（kind: film）');
    const strength = unit(b['strength'], 1), cx = unit(b['cx'], 0.5), cy = unit(b['cy'], 0.5);
    if ([strength, cx, cy].some(Number.isNaN)) problems.push('strength / cx / cy 是 0–1 的数');
    const size = b['size'] === undefined ? 512 : b['size'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 64 || size > 1024) problems.push('size 是 64–1024 的整数');
    if (!film || typeof film !== 'object' || Array.isArray(film)) problems.push('film 是对象');
    else problems.push(...filmEffectProblems(film as Record<string, unknown>));
    if (problems.length) return reply.code(400).send({ error: problems.join('；') });
    try {
      const out = await looks.filmPreview({ photoId: b['photoId'] as string, look: b['look'] as string, strength, film: film as FilmEffects, cx, cy, size: size as number });
      if (!out) return reply.code(404).send({ error: '没这张照片或这个风格' });
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').header('x-render-ms', String(out.ms)).send(Buffer.from(out.jpeg));
    } catch (e) {
      return reply.code(503).send({ error: `胶片引擎渲染失败：${(e as Error).message}` });
    }
  });
}
