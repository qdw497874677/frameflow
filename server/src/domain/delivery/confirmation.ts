/** 外传确认的记录与错误（F14 / F29a）。纯数据，持久化见 adapters/outbound/fs/delivery-confirmations.ts。 */
import type { DispatchParams, PreviewTarget } from './types.ts';

export interface ConfirmInput {
  readonly previewId: string;
  readonly revision: string;
  readonly requestId: string;
  readonly notifyOnComplete: boolean;
  /** 有外部目标时必须为 true：用户已确认将外传到这些目标 */
  readonly acknowledged: boolean;
}

export interface AcceptedSnapshot {
  readonly projectId: string;
  readonly photoIds: readonly string[];
  readonly params: DispatchParams;
  readonly targets: readonly PreviewTarget[];
}

/** F29a：追加目标确认——绑定已有 jobId，只扩展目标投递记录 */
export interface AppendInput extends ConfirmInput { readonly jobId: string }
export interface AppendRecord {
  readonly t: 'appended';
  readonly requestId: string;
  readonly jobId: string;
  readonly previewId: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly targets: readonly PreviewTarget[];
  readonly notifyOnComplete: boolean;
  readonly at: string;
}

export interface ConfirmationRecord {
  readonly t: 'accepted' | 'aborted';
  readonly requestId: string;
  readonly jobId: string;
  readonly previewId: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly snapshot: AcceptedSnapshot;
  readonly at: string;
  readonly reason?: string;
}

export type ConfirmErrorCode =
  | 'INVALID' | 'CONSENT_REQUIRED' | 'REQUEST_ID_CONFLICT' | 'PREVIEW_ALREADY_CONFIRMED' | 'AUTHORIZATION_REVOKED'
  | 'PREVIEW_NOT_FOUND' | 'PREVIEW_EXPIRED' | 'PREVIEW_REVISION_MISMATCH' | 'PREVIEW_STALE'
  | 'JOB_NOT_FOUND' | 'JOB_CLOSED' | 'PREVIEW_JOB_MISMATCH' | 'TARGET_ALREADY_IN_JOB' | 'STORE_CORRUPT';

export class ConfirmError extends Error {
  readonly code: ConfirmErrorCode;
  readonly detail?: string;
  constructor(code: ConfirmErrorCode, message: string, detail?: string) {
    super(message);
    this.code = code;
    if (detail) this.detail = detail;
  }
}
