import type { Photo, Root } from './types';

/**
 * 「待删」口径是全局的：所有在线项目里标了待删的照片（与已搬进回收站的条目同口径），
 * 不随当前打开的目录变化 —— 侧边栏徽标、回收站页在任何目录下都显示同一个数。
 */
export async function listPendingTrash(roots: readonly Root[], listDeleted: (dir: string) => Promise<Photo[]>): Promise<Photo[]> {
  const pages = await Promise.all(roots.filter((r) => r.online).map((r) => listDeleted(r.path)));
  return pages.flat();
}
