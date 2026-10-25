/**
 * 投递策略与预览管理 API（F12）。与连接器管理同一道门：应用密码 + 浏览器 session + 写操作同源。
 * - 策略只引用已配置的 (connectorId, targetId)；任意外部 chat_id / 路径字段一律拒绝（UNKNOWN_FIELD）。
 * - 预览与取消只读写内存预览，零发送；确认/投递在后续模块（F13+）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ConnectorConfigStore } from '../../outbound/fs/connector-config-store.ts';
import { PolicyError, parsePolicy, parseTargetRef } from '../../../domain/delivery/policy.ts';
import type { PolicyStore } from '../../outbound/fs/policy-store.ts';
import type { PreviewService } from '../../../application/delivery/previews.ts';
import type { DeliveryPolicy, DispatchParams, TargetRef } from '../../../domain/delivery/types.ts';
import type { Selection } from '../../../domain/selection.ts';
import { ConfirmError } from '../../../domain/delivery/confirmation.ts';
import type { ConfirmationService } from '../../../application/delivery/confirmation-service.ts';
import type { DeliveryDispatcher } from '../../../application/delivery/dispatcher.ts';
import { managementGuard, revisionOf, safeFieldPath } from './connectors.ts';

export interface DeliveryApiDeps {
  policies: PolicyStore;
  connectors: ConnectorConfigStore;
  previews: PreviewService;
  authEnabled: () => boolean;
  via: (req: FastifyRequest) => string;
  /** 展开选择集为本项目照片 id（只含 rootId === projectId） */
  selectPhotos: (projectId: string, selection: Selection) => string[];
  projectExists: (projectId: string) => boolean;
  /** F16：确认与投递（缺省则不注册这几条路由） */
  confirmations?: ConfirmationService<{ id: string; state: string }>;
  dispatcher?: DeliveryDispatcher;
}

const CONFIRM_STATUS: Record<string, number> = {
  INVALID: 400, CONSENT_REQUIRED: 400, REQUEST_ID_CONFLICT: 409, PREVIEW_ALREADY_CONFIRMED: 409, AUTHORIZATION_REVOKED: 409,
  PREVIEW_NOT_FOUND: 404, PREVIEW_EXPIRED: 410, PREVIEW_REVISION_MISMATCH: 409, PREVIEW_STALE: 409,
  JOB_NOT_FOUND: 404, JOB_CLOSED: 409, PREVIEW_JOB_MISMATCH: 409, TARGET_ALREADY_IN_JOB: 409, STORE_CORRUPT: 503,
};
const RETRY_STATUS: Record<string, number> = { JOB_NOT_FOUND: 404, TARGET_NOT_IN_JOB: 400, NOTHING_TO_RETRY: 409, DUPLICATE_RISK: 409, ATTEMPT_IN_FLIGHT: 409 };

const MAX_LIMIT = 100;
const MAX_TEXT = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const err = (reply: FastifyReply, status: number, code: string, error: string, field?: string) =>
  reply.code(status).send(field ? { error, code, field } : { error, code });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function policyError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof PolicyError) {
    if (e.code === 'REVISION_CONFLICT') return err(reply, 409, e.code, '策略已被修改，请刷新后重试');
    const field = safeFieldPath(e.detail);
    return err(reply, 400, e.code, field ? `投递策略不合法：${field}` : '投递策略不合法', field);
  }
  throw e;
}

function parseParams(v: unknown): DispatchParams | null {
  if (v === undefined) return { alias: null, note: null, notifyOnComplete: false };
  if (!isObj(v)) return null;
  for (const k of Object.keys(v)) if (!['alias', 'note', 'notifyOnComplete'].includes(k)) return null;
  const text = (x: unknown) => (x === undefined || x === null ? null : typeof x === 'string' && x.length <= MAX_TEXT ? x : undefined);
  const alias = text(v['alias']);
  const note = text(v['note']);
  const n = v['notifyOnComplete'] ?? false;
  if (alias === undefined || note === undefined || typeof n !== 'boolean') return null;
  return { alias, note, notifyOnComplete: n };
}

export function registerDeliveryRoutes(app: FastifyInstance, deps: DeliveryApiDeps): void {
  /** 策略目标必须指向已配置的目标，且该目标授权给策略里的每个项目 */
  const checkRefs = (p: DeliveryPolicy): string | null => {
    for (const t of p.targets) {
      const inst = deps.connectors.current.instances.find((i) => i.id === t.connectorId);
      const target = inst?.targets.find((x) => x.id === t.targetId);
      if (!target) return 'TARGET_NOT_FOUND';
      if (!p.projectIds.every((pid) => target.projectIds.includes(pid))) return 'TARGET_PROJECT_NOT_ALLOWED';
    }
    return null;
  };

  app.register(async (scope) => {
    scope.addHook('preHandler', managementGuard(deps.authEnabled, deps.via));

    scope.get('/api/v1/delivery-policies', async (req, reply) => {
      const q = req.query as { limit?: string; cursor?: string };
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return err(reply, 400, 'INVALID_LIMIT', `limit 须为 1–${MAX_LIMIT}`);
      if (!Number.isInteger(start) || start < 0) return err(reply, 400, 'INVALID_CURSOR', 'cursor 不合法');
      const all = deps.policies.current.policies;
      return { revision: deps.policies.current.revision, items: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null };
    });

    const write = (reply: FastifyReply, rev: number, next: unknown[], status: number, id: string | null) => {
      try {
        // 先逐条解析，引用校验通过再落盘
        for (const p of next) {
          const parsed = parsePolicy(p, 0);
          const bad = checkRefs(parsed);
          if (bad) return err(reply, 400, bad, '策略引用了不存在或未授权该项目的目标');
        }
        const doc = deps.policies.replace(next, rev);
        return reply.code(status).send({ revision: doc.revision, policy: id ? doc.policies.find((p) => p.id === id) ?? null : null });
      } catch (e) {
        return policyError(reply, e);
      }
    };

    scope.post('/api/v1/delivery-policies', async (req, reply) => {
      const body = (req.body ?? {}) as { expectedRevision?: unknown; policy?: unknown };
      const rev = revisionOf(body.expectedRevision);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      if (!isObj(body.policy) || 'revision' in body.policy) return err(reply, 400, 'INVALID_FIELD', '投递策略不合法');
      const id = body.policy['id'];
      if (deps.policies.current.policies.some((p) => p.id === id)) return err(reply, 409, 'POLICY_EXISTS', '策略 id 已存在');
      return write(reply, rev, [...deps.policies.current.policies, body.policy], 201, typeof id === 'string' ? id : null);
    });

    scope.patch('/api/v1/delivery-policies/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { expectedRevision?: unknown; patch?: unknown };
      const rev = revisionOf(body.expectedRevision);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      const cur = deps.policies.current.policies.find((p) => p.id === id);
      if (!cur) return err(reply, 404, 'POLICY_NOT_FOUND', '策略不存在');
      if (!isObj(body.patch)) return err(reply, 400, 'INVALID_FIELD', 'patch 必填');
      for (const k of Object.keys(body.patch)) if (!['enabled', 'projectIds', 'event', 'targets'].includes(k)) return err(reply, 400, 'UNKNOWN_FIELD', '投递策略不合法');
      const { revision: _r, ...base } = cur;
      const next = deps.policies.current.policies.map((p) => (p.id === id ? { ...base, ...(body.patch as Record<string, unknown>) } : (({ revision: _x, ...rest }) => rest)(p)));
      return write(reply, rev, next, 200, id);
    });

    scope.delete('/api/v1/delivery-policies/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const rev = revisionOf((req.query as { expectedRevision?: string }).expectedRevision);
      if (rev === null) return err(reply, 400, 'INVALID_REVISION', 'expectedRevision 必填');
      if (!deps.policies.current.policies.some((p) => p.id === id)) return err(reply, 404, 'POLICY_NOT_FOUND', '策略不存在');
      try {
        const doc = deps.policies.replace(deps.policies.current.policies.filter((p) => p.id !== id).map(({ revision: _r, ...rest }) => rest), rev);
        return { revision: doc.revision, policy: null };
      } catch (e) {
        return policyError(reply, e);
      }
    });

    // 预览：零发送。targets 省略 = 按策略推荐；[] = 仅应用内
    scope.post('/api/v1/delivery-previews', async (req, reply) => {
      const body = req.body;
      if (!isObj(body)) return err(reply, 400, 'INVALID_FIELD', '请求体不合法');
      for (const k of Object.keys(body)) if (!['projectId', 'selection', 'params', 'targets'].includes(k)) return err(reply, 400, 'UNKNOWN_FIELD', '不接受该字段');
      const projectId = body['projectId'];
      if (typeof projectId !== 'string' || !ID_RE.test(projectId) || !deps.projectExists(projectId)) return err(reply, 400, 'PROJECT_NOT_FOUND', '项目不存在');
      const params = parseParams(body['params']);
      if (!params) return err(reply, 400, 'INVALID_PARAMS', '派发参数不合法');
      let targets: TargetRef[] | undefined;
      if (body['targets'] !== undefined) {
        if (!Array.isArray(body['targets']) || body['targets'].length > 64) return err(reply, 400, 'INVALID_FIELD', 'targets 不合法');
        try { targets = body['targets'].map((t, i) => parseTargetRef(t, `targets[${i}]`)); } catch (e) { return policyError(reply, e); }
      }
      const selection = (isObj(body['selection']) ? body['selection'] : {}) as Selection;
      let photoIds: string[];
      try { photoIds = deps.selectPhotos(projectId, selection); } catch { return err(reply, 400, 'INVALID_SELECTION', '选择集不合法'); }
      const r = deps.previews.create({ projectId, photoIds, params, targets }, { connectors: deps.connectors.current, policies: deps.policies.current });
      if (!r.ok) return err(reply, r.code === 'EMPTY_SELECTION' ? 400 : 409, r.code, r.code === 'EMPTY_SELECTION' ? '选择集里没有照片' : '目标不可用或未授权该项目，请重新选择');
      const { photoIds: _ids, ...view } = r.preview;
      return reply.code(201).send(view);
    });

    scope.delete('/api/v1/delivery-previews/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!deps.previews.cancel(id)) return err(reply, 404, 'PREVIEW_NOT_FOUND', '预览不存在或已过期');
      return reply.code(204).send();
    });

    const { confirmations, dispatcher } = deps;
    if (!confirmations || !dispatcher) return;

    scope.post('/api/v1/delivery-confirmations', async (req, reply) => {
      const b = req.body;
      if (!isObj(b)) return err(reply, 400, 'INVALID', '请求体不合法');
      for (const k of Object.keys(b)) if (!['previewId', 'revision', 'requestId', 'notifyOnComplete', 'acknowledged'].includes(k)) return err(reply, 400, 'UNKNOWN_FIELD', '不接受该字段');
      if (typeof b['notifyOnComplete'] !== 'boolean' && b['notifyOnComplete'] !== undefined) return err(reply, 400, 'INVALID', 'notifyOnComplete 须为布尔');
      try {
        const r = confirmations.confirm({
          previewId: String(b['previewId'] ?? ''), revision: String(b['revision'] ?? ''), requestId: String(b['requestId'] ?? ''),
          notifyOnComplete: b['notifyOnComplete'] === true, acknowledged: b['acknowledged'] === true,
        });
        const deliveries = r.replayed ? dispatcher.list(r.job.id) ?? [] : dispatcher.start(r.confirmation);
        return reply.code(r.replayed ? 200 : 201).send({
          accepted: true, replayed: r.replayed, requestId: r.confirmation.requestId,
          job: { id: r.job.id, state: r.job.state }, targets: r.confirmation.snapshot.targets, deliveries,
        });
      } catch (e) {
        if (e instanceof ConfirmError) return reply.code(CONFIRM_STATUS[e.code] ?? 400).send({ error: '确认失败', code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
        throw e;
      }
    });

    // F29a：追加目标——预览绑定已有 jobId（照片/参数取原确认快照），零发送
    scope.post('/api/v1/jobs/:id/delivery-previews', async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body;
      if (!isObj(b)) return err(reply, 400, 'INVALID_FIELD', '请求体不合法');
      for (const k of Object.keys(b)) if (k !== 'targets') return err(reply, 400, 'UNKNOWN_FIELD', '不接受该字段');
      const base = confirmations.store.byJob(id);
      if (!base || base.t !== 'accepted') return err(reply, 404, 'JOB_NOT_FOUND', '任务不存在或不是外传任务');
      if (!Array.isArray(b['targets']) || !b['targets'].length || b['targets'].length > 64) return err(reply, 400, 'INVALID_FIELD', 'targets 必填且非空');
      let targets: TargetRef[];
      try { targets = b['targets'].map((t, i) => parseTargetRef(t, `targets[${i}]`)); } catch (e) { return policyError(reply, e); }
      const have = new Set(confirmations.store.targetsOf(id).map((t) => `${t.connectorId}\u0000${t.targetId}`));
      if (targets.some((t) => have.has(`${t.connectorId}\u0000${t.targetId}`))) return err(reply, 409, 'TARGET_ALREADY_IN_JOB', '目标已在任务中；失败重试请用重试入口');
      const r = deps.previews.create({ projectId: base.snapshot.projectId, photoIds: base.snapshot.photoIds, params: base.snapshot.params, targets, jobId: id }, { connectors: deps.connectors.current, policies: deps.policies.current });
      if (!r.ok) return err(reply, r.code === 'EMPTY_SELECTION' ? 400 : 409, r.code, '目标不可用或未授权该项目，请重新选择');
      const { photoIds: _ids, ...view } = r.preview;
      return reply.code(201).send({ ...view, existingTargets: confirmations.store.targetsOf(id) });
    });

    scope.post('/api/v1/jobs/:id/delivery-appends', async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body;
      if (!isObj(b)) return err(reply, 400, 'INVALID', '请求体不合法');
      for (const k of Object.keys(b)) if (!['previewId', 'revision', 'requestId', 'notifyOnComplete', 'acknowledged'].includes(k)) return err(reply, 400, 'UNKNOWN_FIELD', '不接受该字段');
      if (typeof b['notifyOnComplete'] !== 'boolean' && b['notifyOnComplete'] !== undefined) return err(reply, 400, 'INVALID', 'notifyOnComplete 须为布尔');
      try {
        const r = confirmations.confirmAppend({
          jobId: id, previewId: String(b['previewId'] ?? ''), revision: String(b['revision'] ?? ''), requestId: String(b['requestId'] ?? ''),
          notifyOnComplete: b['notifyOnComplete'] === true, acknowledged: b['acknowledged'] === true,
        });
        const deliveries = r.replayed ? dispatcher.list(id) ?? [] : dispatcher.startAppend(r.record);
        return reply.code(r.replayed ? 200 : 201).send({ accepted: true, replayed: r.replayed, requestId: r.record.requestId, jobId: id, targets: r.record.targets, deliveries });
      } catch (e) {
        if (e instanceof ConfirmError) return reply.code(CONFIRM_STATUS[e.code] ?? 400).send({ error: '追加失败', code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
        throw e;
      }
    });

    scope.get('/api/v1/jobs/:id/deliveries', async (req, reply) => {
      const { id } = req.params as { id: string };
      const items = dispatcher.list(id);
      if (!items) return err(reply, 404, 'JOB_NOT_FOUND', '该任务没有外传记录');
      return { jobId: id, items };
    });

    scope.post('/api/v1/jobs/:id/deliveries/retry', async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body;
      if (!isObj(b)) return err(reply, 400, 'INVALID', '请求体不合法');
      for (const k of Object.keys(b)) if (!['connectorId', 'targetId', 'acceptDuplicateRisk'].includes(k)) return err(reply, 400, 'UNKNOWN_FIELD', '不接受该字段');
      let t: TargetRef;
      try { t = parseTargetRef({ connectorId: b['connectorId'], targetId: b['targetId'] }, 'target'); } catch (e) { return policyError(reply, e); }
      const r = dispatcher.retry(id, t, b['acceptDuplicateRisk'] === true);
      if (!r.ok) return err(reply, RETRY_STATUS[r.code] ?? 400, r.code, r.code === 'DUPLICATE_RISK' ? '存在状态未知的消息，重试可能重复外传；需 acceptDuplicateRisk: true' : '无法重试');
      return reply.code(202).send({ jobId: id, items: r.items });
    });
  });
}
