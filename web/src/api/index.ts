import { createHttpSource } from './httpSource';
import { createMockSource } from './mockSource';
import type { PhotoSource } from './source';

/**
 * 数据源选择（唯一决策点）：
 *   VITE_API_BASE 未设置 → mock（纯前端开发交互）
 *   VITE_API_BASE=/api/v1 → 真实后端（Vite 代理或反向代理转发）
 */
export function createSource(): PhotoSource {
  const base = import.meta.env.VITE_API_BASE as string | undefined;
  return base ? createHttpSource(base) : createMockSource();
}

export const source: PhotoSource = createSource();
export type { PhotoSource } from './source';
