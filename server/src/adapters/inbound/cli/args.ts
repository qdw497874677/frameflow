/** 命令行里的位置参数：去掉 `--xxx` / `--xxx=…` 开关（如 `--config=…`），顺序保持不变 */
export function positionalArgs(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith('--'));
}
