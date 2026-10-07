import { createHttpAnnotateSource, createHttpJobSource, createHttpSource } from './httpSource';
import { createMockSource } from './mockSource';
import type { AnnotateSource, JobSource, PhotoSource } from './source';

/**
 * 数据源选择（唯一决策点）：
 *   VITE_API_BASE 未设置 → mock（纯前端开发交互）
 *   VITE_API_BASE=/api/v1 → 真实后端（Vite 代理或反向代理转发）
 *
 * 三个端口（库 / 任务 / 批注页）独立选实现，但同一个后端地址：mock 时共用一个闭包实例
 * —— 任务里的 items 必须是同一批假照片，否则「派发这 20 张」会指到不存在的照片。
 */
function base(): string | undefined {
  return import.meta.env.VITE_API_BASE as string | undefined;
}

let mock: (PhotoSource & JobSource & AnnotateSource) | undefined;
function mockSource(): PhotoSource & JobSource & AnnotateSource {
  mock ??= createMockSource();
  return mock;
}

export function createSource(): PhotoSource {
  const b = base();
  return b ? createHttpSource(b) : mockSource();
}

export function createJobSource(): JobSource {
  const b = base();
  return b ? createHttpJobSource(b) : mockSource();
}

/** 批注页专用：凭据是 URL 里的范围 token，不是会话 */
export function createAnnotateSource(): AnnotateSource {
  const b = base();
  return b ? createHttpAnnotateSource(b) : mockSource();
}

export const source: PhotoSource = createSource();
export const jobSource: JobSource = createJobSource();
export const annotateSource: AnnotateSource = createAnnotateSource();
export type { AnnotateSource, JobSource, PhotoSource } from './source';
