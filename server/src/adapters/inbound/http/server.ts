/**
 * HTTP 层：把 contracts/openapi.yaml 铺成实际的路由。
 * 这里**不放业务逻辑** —— 只做参数解析、认证、DTO 组装与流式输出；一切判断都在 application/ 与 domain/ 里；路由按领域分在 routes/。
 */

import { registerConnectorRoutes } from './connectors.ts';
import { registerDeliveryRoutes } from './delivery.ts';
import { PolicyStore } from '../../outbound/fs/policy-store.ts';
import { PreviewService } from '../../../application/delivery/previews.ts';
import { ConfirmationService } from '../../../application/delivery/confirmation-service.ts';
import { ConfirmationStore } from '../../outbound/fs/delivery-confirmations.ts';
import { DeliveryDispatcher } from '../../../application/delivery/dispatcher.ts';
import { DeliveryStore } from '../../outbound/fs/delivery-ledger.ts';
import { ConnectorConfigStore } from '../../outbound/fs/connector-config-store.ts';
import { ConnectorRegistry } from '../../../application/connectors/registry.ts';
import type { ConnectorFactory, ConnectorKind } from '../../../domain/connectors/types.ts';
import { ConnectorRuntime } from '../../../application/connectors/runtime.ts';
import { PidFileLock } from '../../outbound/fs/writer-lock.ts';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../outbound/config-file.ts';
import { JobsStore } from '../../outbound/fs/jobs-store.ts';
import type { Library } from '../../outbound/fs/library.ts';
import { registry } from '../../../application/jobs/registry.ts';
import { JobsService } from '../../../application/jobs/service.ts';
import { reconcileConfirmations } from '../../../application/jobs/confirmations.ts';
import { openFeishuInteraction, type CardModel, type FeishuController } from '../../feishu/index.ts';
import type { SemanticContent } from '../../../domain/connectors/types.ts';
import { Auth } from './auth.ts';
import { registerAuthGate } from './auth-gate.ts';
import { infoOf } from './request.ts';
import { registerJobRoutes } from './routes/jobs.ts';
import { registerLibraryRoutes } from './routes/library.ts';
import { registerMarksRoutes } from './routes/marks.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerTokenRoutes } from './routes/tokens.ts';
import { LoginLimiter } from './login-limiter.ts';

export interface ConnectorFactoryContext {
  readonly resolve: (content: SemanticContent, sessionId?: string) => Promise<CardModel | null>;
}

export interface ServerDeps {
  readonly connectorFactories?: Partial<Record<ConnectorKind, (lib: Library, ctx: ConnectorFactoryContext) => ConnectorFactory>>;
  /** 测试注入：登录限流器（可控时钟） */
  readonly loginLimiter?: LoginLimiter;
}

export async function buildServer(cfg: Config, lib: Library, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: cfg.logLevel }, bodyLimit: 8 * 1024 * 1024, trustProxy: cfg.trustProxy === true });
  const auth = new Auth(cfg.dataDir, cfg.password);
  // 任务层：磁盘上两份追加日志（core/jobs.ts），执行由进程内一个队列兜（jobs/service.ts）。
  // 签发批注链接的能力在这里注入，handler 自己不碰 auth。
  const jobs = new JobsService(new JobsStore(cfg.dataDir), registry, {
    lib,
    signRangeToken: (jobId, alias, tokenId) => auth.issueRangeToken(jobId, alias, tokenId),
    // F29：完成通知（只发给确认时同意通知的目标；同代次不重发）
    onDone: (job, generation) => { onJobDone(job.id, generation); },
  });
  let onJobDone: (jobId: string, generation: number) => void = () => undefined;
  await app.register(cookie);

  // ── 连接器（F08/F09）：配置在 dataDir/connectors.json；尚未注册任何平台适配器，启用实例只会报 CONNECTOR_KIND_UNSUPPORTED
  const connectorStore = ConnectorConfigStore.open(cfg.dataDir);
  const connectorRegistry = new ConnectorRegistry();
  // 飞书交互（F22–F24）：控制器晚绑定（依赖投递账本），事件与卡片解析都经它
  let feishu: FeishuController | null = null;
  let receiving = false;
  const fctx: ConnectorFactoryContext = { resolve: async (c, sid) => (feishu ? feishu.resolve(c, sid) : null) };
  for (const [kind, make] of Object.entries(deps.connectorFactories ?? {})) if (make) connectorRegistry.register(kind as ConnectorKind, make(lib, fctx));
  const connectorRuntime = new ConnectorRuntime(connectorStore, connectorRegistry, new PidFileLock(cfg.dataDir),
    // F31：恢复/对账完成前不受理入站事件（先对账再开接收）
    async (id, ev) => (feishu && receiving ? feishu.handle(id, ev) : { kind: 'rejected', code: 'RECOVERING' }), process.env);
  await connectorRuntime.sync();
  app.addHook('onClose', async () => connectorRuntime.stopAll());
  // ── 投递策略与预览（F11/F12）：策略在 dataDir/delivery-policies.json，预览只在内存、零发送
  const policyStore = PolicyStore.open(cfg.dataDir);
  const previews = new PreviewService();
  registerConnectorRoutes(app, {
    store: connectorStore, runtime: connectorRuntime, authEnabled: () => auth.enabled, via: (req) => infoOf(req).via,
    isReferenced: (cid) => policyStore.current.policies.some((p) => p.targets.some((t) => t.connectorId === cid)),
  });
  // ── 确认与外传（F13–F16）：经连接器运行时发送；未注册适配器/未启用即 failed（不触网）
  const pstate = () => ({ connectors: connectorStore.current, policies: policyStore.current });
  const confirmStore = ConfirmationStore.open(cfg.dataDir);
  const deliveryStore = DeliveryStore.open(cfg.dataDir);
  const interaction = openFeishuInteraction(cfg.dataDir, {
    config: () => connectorStore.current,
    jobs: {
      get: (id) => { try { return jobs.get(id); } catch { return undefined; } },
      runInJobGate: (id, fn) => jobs.runInJobGate(id, fn),
      projectConfirmation: (id, p) => jobs.projectConfirmation(id, p),
    },
    marks: lib,
    projectOf: (id) => confirmStore.byJob(id)?.snapshot.projectId,
    deliveredTargets: (id) => deliveryStore.listJob(id).filter((p) => p.state === 'sent').map((p) => p.targetId),
    send: (cid, input) => connectorRuntime.send(cid, input),
    update: (cid, input) => connectorRuntime.update(cid, input),
    // F25：只列已成功投递到该目标的任务
    jobsForTarget: (_cid, targetId) => jobs.list({ limit: 500 }).filter((j) => deliveryStore.listJob(j.id).some((p) => p.targetId === targetId && p.state === 'sent')),
    // F26：飞书内创建 = 同一预览 + 一次确认（ConfirmationService），目标固定为当前会话
    creation: {
      projectName: (pid) => lib.roots().find((r) => r.id === pid)?.label,
      preview: (projectId, target) => {
        const r = previews.create({ projectId, photoIds: lib.select({ project: projectId }).filter((x) => x.rootId === projectId).map((x) => x.id), params: { alias: null, note: null, notifyOnComplete: false }, targets: [target] }, pstate());
        return r.ok ? { ok: true, previewId: r.preview.previewId, revision: r.preview.revision, photoCount: r.preview.photoCount } : { ok: false, code: r.code };
      },
      confirm: async (input) => {
        const r = confirmations.confirm({ ...input, notifyOnComplete: false, acknowledged: true });
        if (!r.replayed) dispatcher.start(r.confirmation);
        return { jobId: r.job.id, replayed: r.replayed };
      },
    },
  });
  feishu = interaction.controller;
  const dispatcher = new DeliveryDispatcher({
    store: deliveryStore, confirmations: confirmStore, state: pstate,
    transport: process.env.FRAMEFLOW_FAKE_TRANSPORT === 'e2e'
      // 仅浏览器 e2e：离线假传输，目标 externalId 以 oc_fail 开头的失败，其余成功；绝不触网
      ? { send: async (r) => {
          const t = connectorStore.current.instances.find((c) => c.id === r.connectorId)?.targets.find((x) => x.id === r.targetId);
          if (!t || t.externalId.startsWith('oc_fail')) throw new Error('FAKE_FAIL');
          return { messageId: `fake_${r.intentId}` };
        } }
      // 真实外传经运行时：执行时刻重新授权（实例停用/目标删除即拒绝）
      : interaction.transport,
  });
  const selectIds = (projectId: string, ids: readonly string[]) =>
    lib.select({ ids: [...ids], project: projectId }).filter((r) => r.rootId === projectId).map((r) => r.id);
  const confirmations = new ConfirmationService(confirmStore, {
    previews, state: pstate, currentPhotoIds: selectIds,
    findJob: (id) => { try { return jobs.get(id); } catch { return undefined; } },
    jobOpen: (id) => { try { return !['cancelled', 'failed'].includes(jobs.get(id).state); } catch { return false; } },
    createJob: (rec) => jobs.createConfirmed({
      jobId: rec.jobId, requestId: rec.requestId, kind: 'annotate', selection: { ids: [...rec.snapshot.photoIds], project: rec.snapshot.projectId },
      params: { channel: 'inapp', label: (rec.snapshot.params.alias ?? '').replace(/[|\n\r]/g, ' ').trim().slice(0, 40) || '外部批注', note: rec.snapshot.params.note, notifyOnComplete: rec.snapshot.params.notifyOnComplete, projectId: rec.snapshot.projectId },
      items: rec.snapshot.photoIds.map((id) => ({ id })), by: 'delivery-confirmation',
      // F23：有外部目标的任务按唯一照片明确确认计数
      ...(rec.snapshot.targets.length ? { confirmationMode: 'explicit' as const } : {}),
    }),
  });
  onJobDone = (jobId, generation) => { dispatcher.notifyCompleted(jobId, generation); };
  try { confirmations.recover(); } catch (e) { app.log.warn({ err: e }, '确认恢复失败'); }
  // F23/F24 恢复：先按 marks 日志补已提交未投影的确认，再重放仍为 accepted 的卡片动作
  for (const j of jobs.list({})) {
    if (j.confirmationMode !== 'explicit') continue;
    try {
      await reconcileConfirmations({
        confirmedOps: (id) => lib.marks.confirmedOps(id), hasProjected: (id, op) => jobs.hasProjected(id, op),
        projectConfirmation: (id, p) => jobs.projectConfirmation(id, p), get: (id) => { try { return jobs.get(id); } catch { return undefined; } },
      }, j.id);
    } catch (e) { app.log.warn({ err: e, jobId: j.id }, '确认投影对账失败'); }
  }
  feishu.recover();
  receiving = true;
  app.addHook('onClose', async () => feishu?.idle());
  registerDeliveryRoutes(app, {
    confirmations, dispatcher,
    policies: policyStore, connectors: connectorStore, previews, authEnabled: () => auth.enabled, via: (req) => infoOf(req).via,
    projectExists: (id) => lib.roots().some((r) => r.id === id),
    selectPhotos: (projectId, selection) => lib.select({ ...selection, project: projectId }).filter((r) => r.rootId === projectId).map((r) => r.id),
  });

  registerAuthGate(app, auth, jobs);
  registerSystemRoutes(app, { cfg, auth, lib, connectorRegistry, connectorStore, connectorRuntime, loginLimiter: deps.loginLimiter ?? new LoginLimiter() });
  registerLibraryRoutes(app, { lib });
  registerMarksRoutes(app, { lib });
  registerTokenRoutes(app, { auth, via: (req) => infoOf(req).via });
  registerJobRoutes(app, { jobs, lib });
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
