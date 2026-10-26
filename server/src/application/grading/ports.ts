/**
 * 滤镜阶段的出站端口。application 只认这些接口；sharp、文件系统、.cube 文件都在 adapters/outbound/grading。
 * 加来源 / 渲染器 / 导出目标 = 多写一个适配器，在组装根换上即可。
 */
import type { Effect } from '../../domain/grading/effects.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import type { Look } from '../../domain/grading/recipe.ts';

/** 风格从哪来（内置 .cube、以后用户导入…） */
export interface LookSource {
  list(): Look[];
  load(id: string): Promise<Lut3D | null>;
}

/** 把一张照片按效果管线渲染成成品（全尺寸 JPEG） */
export interface Renderer {
  render(photoId: string, effects: readonly Effect[]): Promise<Uint8Array>;
}

/** 成品放哪（数据目录、照片旁、NAS…） */
export interface ExportTarget {
  /** 任务的成品目录（写进 artifacts） */
  locate(jobId: string): string;
  write(jobId: string, fileName: string, data: Uint8Array): Promise<{ path: string; bytes: number }>;
}

export interface GradingPorts {
  looks: LookSource;
  renderer: Renderer;
  exports: ExportTarget;
  /** 后台导出同时渲染几张（sharp 自己多线程，缺省 2 张就能吃满 CPU 又不爆内存） */
  concurrency?: number;
}
