/** 数据目录的只读视图：相对路径列表 + 按路径读文本 */
export interface DataDirReader {
  list(): string[];
  read(file: string): string;
}

/** 修复用：先把原文件另存一份备份，再原子替换内容；返回备份文件的相对路径 */
export interface DataDirRepairer extends DataDirReader {
  backupAndReplace(file: string, text: string): string;
}
