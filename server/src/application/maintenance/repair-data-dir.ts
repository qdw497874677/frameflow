import { kindOf, repairJsonl } from '../../domain/maintenance/data-files.ts';
import type { DataDirRepairer } from './ports.ts';

export interface RepairedFile { file: string; backup: string; droppedLines: number[]; tailRemoved: boolean }

/**
 * 修复数据目录里的 jsonl 追加日志：剔除坏的完整行与半截尾行，原文件先备份。
 * json 文件是整体替换写入，坏了没法按行抢救，只由体检报告、交给人处理。
 */
export function repairDataDir(dir: DataDirRepairer): RepairedFile[] {
  return dir.list().filter((f) => kindOf(f) === 'jsonl').flatMap((file) => {
    const fix = repairJsonl(dir.read(file));
    if (!fix) return [];
    const backup = dir.backupAndReplace(file, fix.text);
    return [{ file, backup, droppedLines: fix.droppedLines, tailRemoved: fix.tailRemoved }];
  });
}
