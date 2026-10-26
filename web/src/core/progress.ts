/** 与服务端 jobProgress 一致：skipped 不进分子也不进分母 */
export function itemsProgress(items: { status: string }[]): { done: number; total: number } {
  const work = items.filter((i) => i.status !== 'skipped');
  return { done: work.filter((i) => i.status !== 'planned').length, total: work.length };
}
