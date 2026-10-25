/** 外传账本的分片视图（F15）：一个目标的一个分片的投递状态。 */
export type PartState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';

export interface PartKey {
  readonly jobId: string;
  readonly connectorId: string;
  readonly targetId: string;
  readonly partIndex: number;
}

export interface PartView extends PartKey {
  readonly state: PartState;
  readonly attempts: number;
  readonly currentIntentId: string | null;
  readonly messageId: string | null;
  readonly error: string | null;
}
