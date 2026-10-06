/**
 * 启动入口。
 *
 * 顺序有意为之：**先监听，再后台扫描**。库在 NAS 上时第一次扫描要跑很久，
 * 不能让人对着一个转圈的端口等；先能连上、能看见进度，扫完了自然就有照片了。
 */

import { buildServer } from './api/server.ts';
import { loadConfig } from './config.ts';
import { endExif } from './core/exif.ts';
import { Library } from './core/library.ts';

const cfg = loadConfig();
const lib = new Library(cfg);
const app = await buildServer(cfg, lib);

await app.listen({ host: cfg.host, port: cfg.port });

app.log.info(
  {
    dataDir: cfg.dataDir,
    auth: cfg.password ? '密码认证已开启' : '免认证（只在本机开发时这样用）',
    roots: cfg.roots.map((r) => `${r.id}:${r.path}`),
  },
  'art-workspace server 已启动',
);

void lib
  .refresh()
  .then((r) => app.log.info({ photos: r.photos, files: r.files, ms: r.ms, errors: r.errors.length }, '首次扫描完成'))
  .catch((err) => app.log.error({ err }, '首次扫描失败'));

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} —— 收摊`);
    void app
      .close()
      .catch(() => undefined)
      .then(() => endExif())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}
