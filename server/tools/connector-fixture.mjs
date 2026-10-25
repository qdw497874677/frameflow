/**
 * 连接器集成故障注入夹具（F31）：在临时 dataDir 上起**真实** buildServer（进程内 inject，不监听端口），
 * 飞书适配器换成可编排的假 SDK（不触网）。可在同一 dataDir 上反复 stop()/start() 模拟崩溃重启。
 * 绝不触碰用户数据：库与 dataDir 都在 os.tmpdir() 下，dispose() 删除。
 */
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../src/config.ts';
import { Library } from '../src/core/library.ts';
import { buildServer } from '../src/api/server.ts';
import { feishuFactory } from '../src/connectors/feishu/transport.ts';

export const PASSWORD = 'fixture-local-password';
export const SECRET_ENV = 'FRAMEFLOW_FIXTURE_FAKE_SECRET';

/** 假 SDK：behave.create(req, n) 可返回结果 / 抛错 / 返回永不结束或迟到的 promise */
export function scriptedSdk(behave = {}) {
  const calls = { create: [], patch: [], upload: [], verify: 0, wsStart: 0 };
  const state = { handlers: null, onStart: null };
  const sdk = {
    api: () => ({
      createMessage: async (r) => { calls.create.push(r); return behave.create ? behave.create(r, calls.create.length) : { code: 0, data: { message_id: `om_${calls.create.length}` } }; },
      patchMessage: async (r) => { calls.patch.push(r); return { code: 0 }; },
      uploadImage: async (b) => { calls.upload.push(b.length); return { code: 0, data: { image_key: `img_${calls.upload.length}` } }; },
      uploadFile: async () => ({ code: 0, data: { file_key: 'file_1' } }),
      verifyToken: async () => { calls.verify++; return { code: 0 }; },
    }),
    longConnection: () => ({
      start: async (h) => { calls.wsStart++; state.handlers = h; if (state.onStart) await state.onStart(h); },
      close: () => undefined,
    }),
  };
  return { sdk, calls, state };
}

export async function makeFixture({ photos = 2, sdk = scriptedSdk(), transportTimeoutMs = 200 } = {}) {
  const require = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), '../package.json'));
  const sharp = require('sharp');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-connector-fixture-'));
  const library = path.join(dir, 'lib');
  fs.mkdirSync(library);
  for (let i = 0; i < photos; i++) fs.writeFileSync(path.join(library, `P${i}.jpg`), await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10 * i, g: 80, b: 120 } } }).jpeg().toBuffer());
  const dataDir = path.join(dir, 'data');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ host: '127.0.0.1', port: 0, password: PASSWORD, dataDir, logLevel: 'silent', roots: [{ id: 'p', label: '夹具项目', path: library }] }));
  process.env[SECRET_ENV] = 'fixture-fake-value';

  let app = null;
  let cookie = '';
  const fx = {
    dir, dataDir, sdk,
    get app() { return app; },
    async start() {
      const cfg = loadConfig([`--config=${configFile}`]);
      const lib = new Library(cfg);
      await lib.refresh();
      app = await buildServer(cfg, lib, {
        connectorFactories: {
          feishu: (l, ctx) => feishuFactory({
            sdk: () => sdk.sdk, resolve: ctx.resolve, timeoutMs: transportTimeoutMs,
            preview: async (id) => { const rec = l.get(id); const { path: p, etag } = await l.thumbs.thumb(rec, 2048); return { path: p, signature: etag }; },
          }),
        },
      });
      await app.ready();
      const r = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { password: PASSWORD }, headers: { host: 'ff.local', origin: 'http://ff.local' } });
      cookie = [r.headers['set-cookie']].flat().filter(Boolean).map((c) => c.split(';')[0]).join('; ');
      return fx;
    },
    /** 模拟崩溃/重启：关闭当前实例（最多等 1s 收尾），保留 dataDir */
    async stop() {
      if (!app) return;
      const a = app; app = null;
      await Promise.race([a.close(), new Promise((r) => setTimeout(r, 1000))]);
    },
    async restart() { await fx.stop(); return fx.start(); },
    async call(method, url, payload) {
      const r = await app.inject({ method, url, payload, headers: { host: 'ff.local', origin: 'http://ff.local', cookie } });
      let json = null; try { json = r.json(); } catch { /* 空 */ }
      return { status: r.statusCode, json };
    },
    /** 建一个启用的飞书实例（目标 g1/g2 均授权项目 p） */
    async connector({ targets = ['g1', 'g2'] } = {}) {
      let rev = (await fx.call('GET', '/api/v1/connectors')).json.revision;
      const instance = { id: 'c1', kind: 'feishu', label: '飞书', appId: 'cli_fixture', secretEnv: SECRET_ENV, tenantId: 'tk1', creatorActorIds: [], creatorProjectIds: [],
        targets: targets.map((id) => ({ id, connectorId: 'c1', label: id, kind: 'group', externalId: `oc_${id}`, projectIds: ['p'], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false })) };
      let r = await fx.call('POST', '/api/v1/connectors', { expectedRevision: rev, instance });
      if (r.status >= 300) throw new Error(JSON.stringify(r));
      rev = r.json.revision;
      r = await fx.call('PATCH', '/api/v1/connectors/c1', { expectedRevision: rev, patch: { enabled: true } });
      if (r.status >= 300) throw new Error(JSON.stringify(r));
      return r.json.revision;
    },
    async dispatch(targets, requestId) {
      const pv = await fx.call('POST', '/api/v1/delivery-previews', { projectId: 'p', targets: targets.map((targetId) => ({ connectorId: 'c1', targetId })) });
      if (pv.status !== 201) throw new Error(JSON.stringify(pv));
      return fx.call('POST', '/api/v1/delivery-confirmations', { previewId: pv.json.previewId, revision: pv.json.revision, requestId, notifyOnComplete: false, acknowledged: true });
    },
    deliveries: async (jobId) => (await fx.call('GET', `/api/v1/jobs/${jobId}/deliveries`)).json?.items ?? [],
    async waitParts(jobId, pred, ms = 3000) {
      const end = Date.now() + ms;
      let items = [];
      while (Date.now() < end) { items = await fx.deliveries(jobId); if (items.length && pred(items)) return items; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error(`等待投递状态超时 ${JSON.stringify(items)}`);
    },
    file: (name) => path.join(dataDir, name),
    async dispose() { await fx.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return fx.start();
}
