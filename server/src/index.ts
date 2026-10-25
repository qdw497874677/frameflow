/**
 * 启动入口。
 *
 * 顺序有意为之：**先监听，再后台扫描**。库在 NAS 上时第一次扫描要跑很久，
 * 不能让人对着一个转圈的端口等；先能连上、能看见进度，扫完了自然就有照片了。
 */

import { buildServer } from './adapters/inbound/http/server.ts';
import { loadConfig } from './adapters/outbound/config-file.ts';
import { loadRealSdk } from './adapters/feishu/client.ts';
import { fakeE2eSdk } from './adapters/feishu/fake-sdk.ts';
import { MediaError } from './adapters/feishu/media.ts';
import { feishuFactory } from './adapters/feishu/transport.ts';
import { endExif } from './adapters/outbound/exif.ts';
import { Library } from './adapters/outbound/fs/library.ts';

const cfg = loadConfig();
const lib = new Library(cfg);
// 飞书适配器（F21）：SDK 动态加载；只有显式启用的实例才会建连接。
// FRAMEFLOW_FEISHU_SDK=disabled 时不注册（离线 e2e 用，启用实例只会报 CONNECTOR_KIND_UNSUPPORTED）。
// FRAMEFLOW_FEISHU_SDK=fake-e2e：离线假 SDK（只记录调用，不触网），供浏览器测试发送回归。
const sdkMode = process.env.FRAMEFLOW_FEISHU_SDK;
const feishuSdk = sdkMode === 'disabled' ? null : sdkMode === 'fake-e2e' ? fakeE2eSdk(process.env.FRAMEFLOW_FAKE_SDK_LOG) : await loadRealSdk();
const app = await buildServer(cfg, lib, {
  connectorFactories: feishuSdk
    ? {
        feishu: (l, ctx) => feishuFactory({
          sdk: () => feishuSdk,
          resolve: ctx.resolve,
          preview: async (photoId) => {
            const rec = l.get(photoId);
            if (!rec) throw new Error('PHOTO_NOT_FOUND');
            const { path, etag } = await l.thumbs.thumb(rec, 2048);
            return { path, signature: etag };
          },
          // F28：只取 JPEG 变体；RAW/HEIC-only/视频没有 jpeg → 拒绝（不转码、不用预览兜底）
          original: async (photoId) => {
            const rec = l.get(photoId);
            const f = rec ? l.absFile(rec, 'jpeg') : null;
            if (!f || f.mime !== 'image/jpeg') throw new MediaError('JPEG_UNSUPPORTED');
            return { path: f.path, fileName: f.name };
          },
        }),
      }
    : {},
});

await app.listen({ host: cfg.host, port: cfg.port });

app.log.info(
  {
    dataDir: cfg.dataDir,
    auth: cfg.password ? '密码认证已开启' : '免认证（只在本机开发时这样用）',
    roots: cfg.roots.map((r) => `${r.id}:${r.path}`),
    cacheMaxBytes: cfg.cache.maxBytes || '不限',
  },
  'art-workspace server 已启动',
);

// 冷启动先吃上次的索引：列表立刻能服务，随后 refresh() 在后台把盘上的变化扫进来
const cached = lib.restoredFromCache;
if (cached) {
  app.log.info(
    { photos: cached.photos, savedAt: cached.savedAt },
    '索引缓存已就绪：先按上次扫描的列表服务，后台补扫中',
  );
}

// 根目录在不在：异步探一次（挂死的挂载也不能堵住事件循环），随后 refresh() 会再校正
void lib.probeRoots().catch(() => undefined);

// 索引比 autoRescanAfterDays 还旧：这次的启动扫描就是「补扫」（票 013）
if (lib.noteAutoRescanAtBoot()) {
  app.log.info({ afterDays: cfg.scan.autoRescanAfterDays }, '索引已过期：启动补扫一次');
}

// 预览缓存（票 013）：起监听之后再收拾 —— 大库启动时不跟首次扫描抢 IO。
// 超上限就按 atime 从旧到新删到 90%，每 10 分钟再看一眼（长时间运行也不会涨到失控）。
void lib
  .maintainCache()
  .then((res) => {
    if (!res) return app.log.info({ maxBytes: 0 }, '预览缓存不限容量（cache.maxBytes = 0）');
    app.log.info(
      { bytes: res.bytes, files: res.files, deleted: res.deleted, freedBytes: res.freedBytes, maxBytes: cfg.cache.maxBytes },
      res.deleted ? '预览缓存已淘汰最久未用的部分' : '预览缓存未超上限',
    );
  })
  .catch((err) => app.log.warn({ err }, '缓存维护失败（不影响服务）'));

// 巡检间隔（缓存淘汰 + 失联项目重探 + 索引过期补扫）。默认 10 分钟，e2e 里用环境变量调短。
const TOUR_MS = (() => {
  const raw = Number(process.env['ARTWORKS_TOUR_MS'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
})();

const cacheTimer = setInterval(() => {
  void lib
    .maintainCache()
    .then((res) => {
      if (res?.deleted) {
        app.log.info({ deleted: res.deleted, freedBytes: res.freedBytes, bytes: res.bytes }, '预览缓存定期淘汰');
      }
    })
    .catch(() => undefined);
  // 索引放旧了就补扫一次：NAS 上的实例可能几周不重启，新照片不能等到下次重启
  if (lib.checkAutoRescan()) app.log.info('索引超过 autoRescanAfterDays：自动补扫');
  // 失联的项目（挂载掉了/目录没了）再探一下，回来了就自动补扫 —— 不用等人点「重扫」
  void lib
    .reprobeOfflineRoots()
    .then((recovered) => {
      if (recovered) app.log.info('失联的项目又能访问了：自动补扫');
    })
    .catch(() => undefined);
}, TOUR_MS);
cacheTimer.unref();

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
