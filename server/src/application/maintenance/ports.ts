/** 数据目录的只读视图：相对路径列表 + 按路径读文本 */
export interface DataDirReader {
  list(): string[];
  read(file: string): string;
}
