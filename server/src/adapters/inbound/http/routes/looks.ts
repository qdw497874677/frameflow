/** 滤镜风格：列表 + 原始 .cube（浏览器 WebGL2 预览与服务端导出读同一份文件） */
import type { FastifyInstance } from 'fastify';
import type { CubeLookSource } from '../../../outbound/grading/cube-looks.ts';

export function registerLookRoutes(app: FastifyInstance, { looks }: { readonly looks: CubeLookSource }): void {
  app.get('/api/v1/looks', async () => ({
    items: looks.list().map((l) => ({ ...l, cube: `/api/v1/looks/${l.id}.cube` })),
    license: 'CC BY-SA 4.0（RawTherapee Film Simulation，Pat David / Pavlov Dmitry / Michael Ezra），见 server/assets/looks/NOTICE',
  }));

  app.get('/api/v1/looks/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const m = /^([a-z0-9]+)\.cube$/.exec(file);
    const text = m ? looks.cubeText(m[1]!) : null;
    if (text === null) return reply.code(404).send({ error: `没这个风格：${file}` });
    return reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(text);
  });
}
