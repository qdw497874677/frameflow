/** 备份命令：`npm run backup -- [--config=…] <目标目录>`（开关与目录顺序不限）。只复制数据目录，不需要停服务（追加日志的尾行残缺会被读取方忽略）。 */
import { loadConfig } from '../../outbound/config-file.ts';
import { DataDirFiles, backupDataDir } from '../../outbound/fs/data-dir.ts';
import { positionalArgs } from './args.ts';

const [dest] = positionalArgs(process.argv.slice(2));
if (!dest) {
  console.error('用法：npm run backup -- [--config=…] <目标目录>');
  process.exit(2);
}
const { dataDir } = loadConfig();
try {
  const { dir, files } = backupDataDir(new DataDirFiles(dataDir), dest);
  console.log(`已备份 ${files} 个文件到 ${dir}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
