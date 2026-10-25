/**
 * delivery-policy 边界类型（F11）。策略只推荐目标；用户确认才授权本次投递。
 * 不 import 任何平台实现。
 */
export type DeliveryEvent = 'task.dispatched' | 'task.completed';
export const DELIVERY_EVENTS: readonly DeliveryEvent[] = ['task.dispatched', 'task.completed'];

export interface TargetRef {
  readonly connectorId: string;
  readonly targetId: string;
}

export interface DeliveryPolicy {
  readonly id: string;
  readonly enabled: boolean;
  /** 明确列出；空数组不匹配任何项目（不是“全部”） */
  readonly projectIds: readonly string[];
  readonly event: DeliveryEvent;
  readonly targets: readonly TargetRef[];
  /** 该策略最近一次修改时的文档 revision */
  readonly revision: number;
}

export interface PolicyDocument {
  readonly version: 1;
  readonly revision: number;
  readonly policies: readonly DeliveryPolicy[];
}

export interface PreviewTarget extends TargetRef {
  readonly label: string;
}

export interface DispatchParams {
  readonly alias: string | null;
  readonly note: string | null;
  readonly notifyOnComplete: boolean;
}

/** 不可变预览：绑定照片快照/项目/参数/目标/策略与连接器版本 */
export interface DeliveryPreview {
  readonly previewId: string;
  /** 快照指纹（sha256），确认时须原样带回 */
  readonly revision: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly projectId: string;
  readonly photoIds: readonly string[];
  readonly photoCount: number;
  readonly params: DispatchParams;
  readonly targets: readonly PreviewTarget[];
  readonly policyRevision: number;
  readonly connectorRevision: number;
  readonly warnings: readonly string[];
}

export type PreviewCheck =
  | { readonly ok: true; readonly preview: DeliveryPreview }
  | { readonly ok: false; readonly code: 'PREVIEW_NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PREVIEW_REVISION_MISMATCH' | 'PREVIEW_STALE'; readonly detail?: string };
