/**
 * connector-core 共享类型（F07）。平台无关：不得 import 任何飞书 SDK 类型，
 * 平台适配器只通过 externalId / 不透明字符串解释自身概念。
 */

export type ConnectorKind = 'feishu';
export type ConnectorTargetKind = 'group' | 'user';
export type ConnectorStatusState = 'disabled' | 'connecting' | 'connected' | 'degraded' | 'error';

export interface ConnectorTarget {
  readonly id: string;
  readonly connectorId: string;
  readonly label: string;
  readonly kind: ConnectorTargetKind;
  /** 平台适配器解释；飞书为 chat_id（group）或 open_id（user）。 */
  readonly externalId: string;
  readonly projectIds: readonly string[];
  /** 群卡片也验证实际操作者；私聊目标中为空表示仅目标本人。 */
  readonly allowedActorIds: readonly string[];
  readonly canAnnotate: boolean;
  readonly canRequestJpeg: boolean;
}

export interface ActorIdentity {
  readonly connectorId: string;
  readonly tenantId: string;
  readonly actorId: string;
}

/** 持久化的非密钥实例配置。状态由运行时维护，不在此处。 */
export interface ConnectorInstanceConfig {
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly label: string;
  readonly appId: string;
  /** 部署环境变量名；文件内永不保存 Secret 值。 */
  readonly secretEnv: string;
  /** 实例绑定的租户；未知时为 null，此时一切事件授权拒绝。 */
  readonly tenantId: string | null;
  readonly enabled: boolean;
  readonly targets: readonly ConnectorTarget[];
  readonly creatorActorIds: readonly string[];
  readonly creatorProjectIds: readonly string[];
}

export interface ConnectorConfigDocument {
  readonly version: 1;
  readonly revision: number;
  readonly instances: readonly ConnectorInstanceConfig[];
}

export interface ConnectorStatus {
  readonly state: ConnectorStatusState;
  /** 脱敏原因代码，例如 SECRET_ENV_MISSING。 */
  readonly reason?: string;
  readonly lastConnectedAt?: string;
}

/** API/UI 可见的脱敏视图：不含 Secret 值。 */
export interface SanitizedConnectorInstance extends ConnectorInstanceConfig {
  readonly secretConfigured: boolean;
}

export type SemanticContent =
  | { readonly type: 'task-entry'; readonly taskId: string }
  | { readonly type: 'photo-review'; readonly taskId: string; readonly photoId: string }
  | { readonly type: 'progress'; readonly taskId: string }
  | { readonly type: 'file'; readonly mediaRef: string }
  | { readonly type: 'test-card' };

export interface SendInput {
  readonly targetId: string;
  readonly intentId: string;
  readonly content: SemanticContent;
  readonly sessionId?: string;
}

export interface UpdateInput extends SendInput {
  readonly messageId: string;
}

export type DeliveryResult =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'failed'; readonly code: string; readonly retryable: boolean }
  | { readonly status: 'unknown'; readonly code: string };

export interface ConnectorEventSource {
  readonly kind: ConnectorTargetKind;
  /** 可信 SDK envelope 中的会话 ID（chat_id / open_id）。 */
  readonly externalId: string;
}

export interface ConnectorEvent {
  readonly identity: ActorIdentity;
  /** 缺少可信会话上下文时为 null，授权必须拒绝。 */
  readonly source: ConnectorEventSource | null;
  readonly messageId?: string;
  readonly eventId?: string;
  /** 未可信业务数据，仅不透明 sessionId/actionId 与表单字段。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

export type EventAck =
  | { readonly kind: 'accepted'; readonly toast?: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly toast?: string };

export interface ConnectorPort {
  send(input: SendInput): Promise<DeliveryResult>;
  update(input: UpdateInput): Promise<DeliveryResult>;
  start(onEvent: (event: ConnectorEvent) => Promise<EventAck>): Promise<void>;
  stop(): Promise<void>;
}
