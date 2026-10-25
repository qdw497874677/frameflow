/**
 * 追加日志的压缩阈值（纯函数）：行数超过下限、且至少是有效状态行数的 ratio 倍时才压缩，
 * 避免小日志或几乎没有冗余的日志反复重写。
 */
export interface CompactionPolicy { minLines: number; ratio: number }

export const DEFAULT_COMPACTION: CompactionPolicy = { minLines: 1000, ratio: 2 };

export function shouldCompact(lines: number, live: number, policy: CompactionPolicy = DEFAULT_COMPACTION): boolean {
  return lines >= policy.minLines && lines >= live * policy.ratio;
}
