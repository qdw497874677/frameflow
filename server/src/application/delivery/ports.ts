/** 外传用例依赖的出站端口；实现见 adapters/outbound/fs/delivery-*.ts。 */
import type { AppendRecord, ConfirmationRecord } from '../../domain/delivery/confirmation.ts';
import type { PartKey, PartState, PartView } from '../../domain/delivery/ledger.ts';
import type { PreviewTarget } from '../../domain/delivery/types.ts';

/** 确认记录日志：先落盘再算接受；corrupt 非空时一切确认/恢复都必须拒绝 */
export interface ConfirmationLog {
  readonly corrupt: string | null;
  get(requestId: string): ConfirmationRecord | undefined;
  getAppend(requestId: string): AppendRecord | undefined;
  appendsOf(jobId: string): AppendRecord[];
  targetsOf(jobId: string): PreviewTarget[];
  requestOfPreview(previewId: string): string | undefined;
  byJob(jobId: string): ConfirmationRecord | undefined;
  all(): ConfirmationRecord[];
  append(record: ConfirmationRecord | AppendRecord): void;
}

/** 投递账本：发送前先记意图，结果按意图结算 */
export interface DeliveryLedger {
  readonly corrupt: string | null;
  ensure(key: PartKey): void;
  beginIntent(key: PartKey): string;
  settle(key: PartKey, intentId: string, state: 'sent' | 'failed' | 'unknown', extra?: { messageId?: string; error?: string }): void;
  view(key: PartKey): PartView | undefined;
  intentState(key: PartKey, intentId: string): PartState | undefined;
  listJob(jobId: string): PartView[];
}
