import { kindOf, repairJsonl } from '../../domain/maintenance/data-files.ts';
import type { DataDirRepairer } from './ports.ts';

export interface RepairedFile { file: string; backup: string; droppedLines: number[]; tailRemoved: boolean }
export interface RefusedFile { file: string; refused: string; droppedLines: number[] }

/** 带版本事务的标注日志：修复绝不能丢版本 */
const VERSIONED_LOGS = new Set(['marks.jsonl']);

/**
 * 修复数据目录里的 jsonl 追加日志：剔除坏的完整行与半截尾行，原文件先备份。
 * 标注日志若剔行会断掉版本链，则原样保留、只报告。
 * json 文件是整体替换写入，坏了没法按行抢救，只由体检报告、交给人处理。
 */
export function repairDataDir(dir: DataDirRepairer): (RepairedFile | RefusedFile)[] {
  return dir.list().filter((f) => kindOf(f) === 'jsonl').flatMap((file): (RepairedFile | RefusedFile)[] => {
    const fix = repairJsonl(dir.read(file), { preserveVersioned: VERSIONED_LOGS.has(file) });
    if (!fix) return [];
    if ('refused' in fix) return [{ file, refused: fix.refused, droppedLines: fix.droppedLines }];
    const backup = dir.backupAndReplace(file, fix.text);
    return [{ file, backup, droppedLines: fix.droppedLines, tailRemoved: fix.tailRemoved }];
  });
}
