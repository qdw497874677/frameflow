/** 标注（星级 / 待删）的输入、状态、变更与事务结果。落盘见 adapters/outbound/fs/marks-*.ts。 */

export interface MarkInput {
  id: string;
  stars?: number;
  del?: boolean;
  at?: string;
  by?: string;
  channel?: string;
  /** 这次变更由哪个任务引起（批注任务回流 / 撤销）；散手标注为 null */
  jobId?: string | null;
}

export interface MarkChange {
  photoId: string;
  displayName?: string;
  field: 'stars' | 'del';
  from: number | boolean | null;
  to: number | boolean | null;
  by: string;
  channel: string;
  at: string;
  jobId?: string | null;
}

export interface MarkState {
  stars: number;
  del: boolean;
  /** 最后一次变更的来源与时刻（`by:` 选择集词就靠它） */
  by: string;
  channel: string;
  at: string;
}

export interface MarkResultDto {
  id: string;
  ok: boolean;
  stars?: number;
  del?: boolean;
  error?: string | null;
}

export interface MarkTransactionRequest {
  opId: string;
  items: MarkInput[];
  /** Checked against the pre-batch revision, including when a photo occurs twice. */
  expectedRevisions?: Record<string, number>;
  /** F04：调用方看到的源版本；与当前不同则 SOURCE_GENERATION_CONFLICT。 */
  expectedGenerations?: Record<string, string>;
  confirmation?: Record<string, unknown>;
}

export interface MarkTransactionResult {
  opId: string;
  results: MarkResultDto[];
  revisions: Record<string, number>;
}
