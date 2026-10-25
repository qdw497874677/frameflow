/** 任务层看到的照片库：只要求选择、写标记、读标记三件事。 */

import type { MarkChange, MarkInput, MarkResultDto } from '../../domain/marks.ts';
import type { PhotoRecord } from '../../domain/photo.ts';
import type { Selection } from '../../domain/selection.ts';
import type { OperationGates } from '../operation-gates.ts';

export interface PhotoCatalog {
  readonly gates: OperationGates;
  select(sel: Selection): PhotoRecord[];
  applyMarks(items: MarkInput[]): Promise<MarkResultDto[]>;
  historyForJob(jobId: string): MarkChange[];
  marksOf(photoId: string): { stars: number; del: boolean; by: string | null } | null;
}
