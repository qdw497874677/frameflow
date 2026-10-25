import type { ActorIdentity, ConnectorConfigDocument, ConnectorEventSource, ConnectorInstanceConfig, ConnectorTarget } from './types.ts';

/**
 * 纯授权决策（F07）。默认拒绝；每次执行前调用（排队动作也须在执行时复验），
 * 身份与来源只取可信 SDK envelope，绝不取卡片 value 自报。
 */
export type ConnectorOperation =
  | 'help'            // 帮助 / 任务入口：不要求已有投递
  | 'create'          // 首次创建预览/确认：额外要求创建权限与允许项目
  | 'viewTask'        // 操作既有任务：要求任务已投递给该目标
  | 'annotate'        // 确认/重新标记：另要求 canAnnotate
  | 'requestJpeg';    // 原图请求：另要求 canRequestJpeg

export type DenyReason =
  | 'CONNECTOR_NOT_FOUND' | 'CONNECTOR_DISABLED' | 'TENANT_UNKNOWN' | 'TENANT_MISMATCH'
  | 'IDENTITY_CONNECTOR_MISMATCH' | 'SOURCE_MISSING' | 'TARGET_NOT_CONFIGURED' | 'ACTOR_NOT_ALLOWED'
  | 'NOT_CREATOR' | 'PROJECT_REQUIRED' | 'PROJECT_NOT_ALLOWED' | 'TASK_REQUIRED' | 'TASK_NOT_DELIVERED'
  | 'PHOTO_NOT_IN_TASK' | 'PHOTO_UNAVAILABLE' | 'ANNOTATE_DENIED' | 'JPEG_DENIED' | 'EXTRA_TARGET_NOT_ALLOWED';

export type AccessDecision =
  | { readonly allowed: true; readonly connector: ConnectorInstanceConfig; readonly target: ConnectorTarget }
  | { readonly allowed: false; readonly reason: DenyReason };

export interface AccessRequest {
  readonly connectorId: string;
  readonly identity: ActorIdentity;
  readonly source: ConnectorEventSource | null;
  readonly operation: ConnectorOperation;
  /** create：所选项目；任务操作：任务所属项目。 */
  readonly projectId?: string;
  /** 任务操作：服务器记录的该任务已投递目标 ID 集合。 */
  readonly taskDeliveredTargetIds?: readonly string[];
  /** 照片操作：照片在任务快照中且当前可访问（由调用方在锁内核对）。 */
  readonly photo?: { readonly inTaskSnapshot: boolean; readonly accessible: boolean };
  /** create：额外选择的投递目标 ID，必须属于同一实例的已配置目标。 */
  readonly extraTargetIds?: readonly string[];
}

function deny(reason: DenyReason): AccessDecision { return { allowed: false, reason }; }

export function findSourceTarget(conn: ConnectorInstanceConfig, source: ConnectorEventSource): ConnectorTarget | undefined {
  return conn.targets.find(t => t.kind === source.kind && t.externalId === source.externalId);
}

export function decideAccess(config: ConnectorConfigDocument, req: AccessRequest): AccessDecision {
  const conn = config.instances.find(c => c.id === req.connectorId);
  if (!conn) return deny('CONNECTOR_NOT_FOUND');
  if (!conn.enabled) return deny('CONNECTOR_DISABLED');
  if (req.identity.connectorId !== conn.id) return deny('IDENTITY_CONNECTOR_MISMATCH');
  if (conn.tenantId === null) return deny('TENANT_UNKNOWN');
  if (req.identity.tenantId !== conn.tenantId) return deny('TENANT_MISMATCH');
  if (!req.source) return deny('SOURCE_MISSING');
  const target = findSourceTarget(conn, req.source);
  if (!target) return deny('TARGET_NOT_CONFIGURED');
  const actor = req.identity.actorId;
  if (target.kind === 'user') {
    if (target.externalId !== actor) return deny('ACTOR_NOT_ALLOWED');
  } else if (!target.allowedActorIds.includes(actor)) return deny('ACTOR_NOT_ALLOWED');

  switch (req.operation) {
    case 'help':
      break;
    case 'create': {
      if (!conn.creatorActorIds.includes(actor)) return deny('NOT_CREATOR');
      if (!req.projectId) return deny('PROJECT_REQUIRED');
      if (!conn.creatorProjectIds.includes(req.projectId) || !target.projectIds.includes(req.projectId)) return deny('PROJECT_NOT_ALLOWED');
      for (const tid of req.extraTargetIds ?? []) {
        const extra = conn.targets.find(t => t.id === tid);
        if (!extra || !extra.projectIds.includes(req.projectId)) return deny('EXTRA_TARGET_NOT_ALLOWED');
      }
      break;
    }
    case 'viewTask':
    case 'annotate':
    case 'requestJpeg': {
      if (!req.taskDeliveredTargetIds) return deny('TASK_REQUIRED');
      if (!req.taskDeliveredTargetIds.includes(target.id)) return deny('TASK_NOT_DELIVERED');
      if (!req.projectId || !target.projectIds.includes(req.projectId)) return deny('PROJECT_NOT_ALLOWED');
      if (req.operation === 'annotate' && !target.canAnnotate) return deny('ANNOTATE_DENIED');
      if (req.operation === 'requestJpeg' && !target.canRequestJpeg) return deny('JPEG_DENIED');
      if (req.operation !== 'viewTask' || req.photo) {
        if (req.operation !== 'viewTask' && !req.photo) return deny('PHOTO_NOT_IN_TASK');
        if (req.photo && !req.photo.inTaskSnapshot) return deny('PHOTO_NOT_IN_TASK');
        if (req.photo && !req.photo.accessible) return deny('PHOTO_UNAVAILABLE');
      }
      break;
    }
    default: {
      const never: never = req.operation;
      void never;
      return deny('TARGET_NOT_CONFIGURED');
    }
  }
  return { allowed: true, connector: conn, target };
}
