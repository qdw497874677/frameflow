/**
 * 修复命令：`npm run repair -- [--config=…]`。请先停服务再运行。
 * 剔除数据目录 jsonl 里的坏行与半截尾行；每个被改的文件先另存为 `<文件>.corrupt-<时间>.bak`。
 */
import { loadConfig } from '../../outbound/config-file.ts';
import { DataDirFiles } from '../../outbound/fs/data-dir.ts';
import { checkDataDir } from '../../../application/maintenance/check-data-dir.ts';
import { repairDataDir } from '../../../application/maintenance/repair-data-dir.ts';

const { dataDir } = loadConfig();
const dir = new DataDirFiles(dataDir);
try {
  const fixed = repairDataDir(dir);
  for (const f of fixed) {
    const what = [f.droppedLines.length ? `剔除第 ${f.droppedLines.join('、')} 行` : '', f.tailRemoved ? '截掉半截尾行' : ''].filter(Boolean).join('，');
    console.log(`${f.file}：${what}（原文件备份为 ${f.backup}）`);
  }
  if (fixed.length === 0) console.log('jsonl 日志没有需要修复的行');
  const left = checkDataDir(dir).filter((f) => f.severity === 'error');
  for (const f of left) console.error(`仍有问题：${f.file} ${f.message}（json 文件需从备份恢复）`);
  process.exit(left.length ? 1 : 0);
} catch (e) {
  console.error(`修复失败：${(e as Error).message}`);
  process.exit(1);
}
