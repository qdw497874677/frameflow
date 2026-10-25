import type { Photo } from './types';

/** 侧边栏文件搜索：显示名或 RAW/JPEG 文件名包含关键字（不区分大小写）；空关键字不算命中 */
export function matchesFileName(photo: Pick<Photo, 'displayName' | 'rawPath' | 'jpegPath'>, needle: string): boolean {
  const q = needle.trim().toLocaleLowerCase();
  if (!q) return false;
  return [photo.displayName, photo.rawPath?.split('/').pop(), photo.jpegPath?.split('/').pop()]
    .some((name) => name?.toLocaleLowerCase().includes(q));
}

/** 搜索或筛选生效时，结果列表取代项目文件列表 —— 否则下面的「全部文件」照常全量显示，看起来像没过滤 */
export function projectListVisible(searchActive: boolean): boolean {
  return !searchActive;
}

/** 目录里「暂无照片或视频」只在真的空时显示：有子目录（树模式下就列在上面）时不显示，免得看着像出错 */
export function emptyHintVisible(input: { photos: number; subfolders: number }): boolean {
  return input.photos === 0 && input.subfolders === 0;
}
