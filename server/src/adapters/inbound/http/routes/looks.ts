/**
 * 风格（Look）：列表（带风格类型）+ 风格类型的参数模式 + 原始 .cube（浏览器 WebGL2 预览与服务端导出读同一份 LUT）
 * + 胶片引擎状态与 100% 裁切预览。术语与模式见 docs/adr/0006-look-and-look-kind.md。
 */
import type { FastifyInstance } from 'fastify';
import type { Look } from '../../../../domain/grading/recipe.ts';
import { filmEffectProblems, type FilmEffects } from '../../../../domain/grading/film.ts';
import type { LookKindSchema, LookParams } from '../../../../domain/grading/look-kind.ts';
import type { FilmKind, LookKind } from '../../../../application/grading/look-kinds.ts';
import type { FilmPreviewRequest } from '../../../outbound/grading/film-preview.ts';

export interface LookCatalog {
  /** 带风格类型：`lut` = 内置 .cube，`film` = 光谱胶片引擎烘焙 */
  entries(): Array<Look & { kind: string }>;
  kinds(): LookKindSchema[];
  kindOf(id: string): LookKind | null;
  /** .cube 文本（params = 该风格的参数，只有影响 LUT 的那些起作用）；没这个风格 = null；有但暂时拿不到 = 'unavailable' */
  cubeText(id: string, params?: LookParams): Promise<string | null | 'unavailable'>;
  filmStatus(): Record<string, unknown>;
  /** 100% 裁切预览（胶片开关打开才有）；null = 照片或风格不存在 */
  filmPreview?(req: FilmPreviewRequest): Promise<{ jpeg: Uint8Array; ms: number } | null>;
  filmKind?: FilmKind;
}

const unit = (v: unknown, d: number) => (v === undefined ? d : typeof v === 'number' && v >= 0 && v <= 1 ? v : NaN);

const CUBE_LICENSE = 'CC BY-SA 4.0（RawTherapee Film Simulation，Pat David / Pavlov Dmitry / Michael Ezra），见 server/assets/looks/NOTICE';
const FILM_NOTE = 'film 类风格由 FrameFlow 光谱胶片引擎从厂商公开数据表实时计算（非官方），来源见 engine/PROVENANCE.md';

/** 查询串 → 参数（数字 / 布尔按模式还原）；只认模式里有的键 */
function queryParams(schema: LookKindSchema, q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of schema.params) {
    const raw = q[d.key];
    if (typeof raw !== 'string') continue;
    out[d.key] = d.type === 'number' || d.type === 'seed' ? Number(raw) : d.type === 'bool' ? raw === 'true' : raw;
  }
  return out;
}

export function registerLookRoutes(app: FastifyInstance, { looks }: { readonly looks: LookCatalog }): void {
  app.get('/api/v1/looks', async () => {
    const items = looks.entries().map((l) => ({ ...l, cube: `/api/v1/looks/${l.id}.cube` }));
    return { items, license: items.some((l) => l.kind === 'film') ? `${CUBE_LICENSE}；${FILM_NOTE}` : CUBE_LICENSE };
  });

  app.get('/api/v1/look-kinds', async () => ({ items: looks.kinds() }));

  app.get('/api/v1/looks/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const m = /^([a-z0-9]+)\.cube$/.exec(file);
    const kind = m ? looks.kindOf(m[1]!) : null;
    let params: LookParams | undefined;
    if (kind) {
      const raw = queryParams(kind.schema(), (req.query ?? {}) as Record<string, unknown>);
      const problems = kind.validate(raw);
      if (problems.length) return reply.code(400).send({ error: problems.join('；') });
      params = Object.keys(raw).length ? kind.normalize(raw) : undefined;
    }
    const text = m ? await looks.cubeText(m[1]!, params) : null;
    if (text === null) return reply.code(404).send({ error: `没这个风格：${file}` });
    if (text === 'unavailable') return reply.code(503).send({ error: `胶片引擎暂时不可用，也没有缓存：${file}` });
    return reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(text);
  });

  app.get('/api/v1/film/status', async () => looks.filmStatus());

  /** body：{ photoId, look, params?（film 类型参数）, cx?, cy?, size? }；旧写法 { strength?, film? } 仍收 */
  app.post('/api/v1/film/preview', async (req, reply) => {
    if (!looks.filmPreview || !looks.filmKind) return reply.code(404).send({ error: '胶片模拟没打开（film.enabled）' });
    const fk = looks.filmKind;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (typeof b['photoId'] !== 'string') problems.push('要带 photoId');
    if (typeof b['look'] !== 'string' || looks.kindOf(b['look'])?.kind !== 'film') problems.push('look 要是光谱胶片风格（kind: film）');
    const cx = unit(b['cx'], 0.5), cy = unit(b['cy'], 0.5);
    if ([cx, cy].some(Number.isNaN)) problems.push('cx / cy 是 0–1 的数');
    const size = b['size'] === undefined ? 512 : b['size'];
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 64 || size > 1024) problems.push('size 是 64–1024 的整数');
    let params: Record<string, unknown> = {};
    if (b['params'] !== undefined) {
      problems.push(...fk.validate(b['params']));
      if (b['params'] && typeof b['params'] === 'object') params = { ...(b['params'] as Record<string, unknown>) };
    } else {
      const film = b['film'] ?? {};
      const strength = unit(b['strength'], 1);
      if (Number.isNaN(strength)) problems.push('strength 是 0–1 的数');
      if (!film || typeof film !== 'object' || Array.isArray(film)) problems.push('film 是对象');
      else { problems.push(...filmEffectProblems(film as Record<string, unknown>)); params = { ...(film as Record<string, unknown>), strength }; }
    }
    if (problems.length) return reply.code(400).send({ error: problems.join('；') });
    const p = fk.normalize(params);
    const strength = typeof p['strength'] === 'number' ? p['strength'] : 1;
    try {
      const out = await looks.filmPreview({ photoId: b['photoId'] as string, look: b['look'] as string, strength, film: fk.filmEffects(p) as FilmEffects, variant: fk.variant(p), cx, cy, size: size as number });
      if (!out) return reply.code(404).send({ error: '没这张照片或这个风格' });
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').header('x-render-ms', String(out.ms)).send(Buffer.from(out.jpeg));
    } catch (e) {
      return reply.code(503).send({ error: `胶片引擎渲染失败：${(e as Error).message}` });
    }
  });
}
