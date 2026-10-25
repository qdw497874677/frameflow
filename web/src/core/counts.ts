/**
 * 挑片列表的计数口径：「第 N / M 张」「载入 a/b 张」只数**当前列表**里的照片。
 * 默认藏起来的待删不算进 M（否则会出现「第 1/3 张」却只能翻 2 张），另外单独提示。
 * 侧边栏目录计数同一口径：服务端给的 photoCount 已不含待删，待删数单独在 deletedCount。
 */
export function listCounts(input: { loaded: number; pageTotal?: number; deletedInFolder?: number; showingDeleted: boolean }): { total: number; hiddenDeleted: number } {
  const total = Math.max(input.pageTotal ?? input.loaded, input.loaded);
  const hiddenDeleted = input.showingDeleted ? 0 : Math.max(0, input.deletedInFolder ?? 0);
  return { total, hiddenDeleted };
}
