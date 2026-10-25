import { checkFile, kindOf, type Finding } from '../../domain/maintenance/data-files.ts';
import type { DataDirReader } from './ports.ts';

/** 启动体检：逐个检查数据目录里的 json / jsonl / 临时文件 */
export function checkDataDir(dir: DataDirReader): Finding[] {
  return dir.list().filter((f) => kindOf(f) !== null).flatMap((f) => checkFile(f, kindOf(f) === 'tmp' ? '' : dir.read(f)));
}
