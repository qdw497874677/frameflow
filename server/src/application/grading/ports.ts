/**
 * 滤镜阶段的出站端口。application 只认这些接口；sharp、文件系统、.cube 文件都在 adapters/outbound/grading。
 * 加来源 / 渲染器 / 导出目标 = 多写一个适配器，在组装根换上即可。
 */
import type { Effect } from '../../domain/grading/effects.ts';
import type { Lut3D } from '../../domain/grading/lut.ts';
import type { Look } from '../../domain/grading/recipe.ts';
import type { FilmParams, FilmStock } from '../../domain/grading/film.ts';

/** 风格从哪来（内置 .cube、以后用户导入…） */
export interface LookSource {
  list(): Look[];
  load(id: string): Promise<Lut3D | null>;
}

/** 光谱胶片引擎（独立进程，见 engine/）。适配器负责进程池、超时、重启与健康状态 */
export interface FilmEngine {
  stocks(): Promise<FilmStock[]>;
  /** 烘焙 size³ 的 3D LUT（sRGB 进、sRGB 出） */
  bakeLut(req: { stock: string; paper?: string; size: number; params?: FilmParams }): Promise<Lut3D>;
  /** 引擎版本（进 LUT 缓存键；未连上时为 null） */
  version(): string | null;
  health(): FilmEngineHealth;
}

export interface FilmEngineHealth {
  readonly state: 'idle' | 'starting' | 'up' | 'down';
  readonly version: string | null;
  readonly restarts: number;
  readonly lastError: string | null;
}

/** 烘焙好的 LUT 存哪（数据目录缓存）：引擎挂了时的降级来源 */
export interface FilmLutStore {
  read(key: string): Promise<Lut3D | null>;
  write(key: string, lut: Lut3D): Promise<void>;
  /** 上次见到的胶片目录（引擎没起来时也能列出风格） */
  readCatalog(): Promise<FilmStock[] | null>;
  writeCatalog(stocks: readonly FilmStock[]): Promise<void>;
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

/** 成品元数据：把原片的拍摄信息抄到导出文件上（朝向归 1、ICC 不动、GPS 按选项） */
export interface ExportMetadata {
  carry(photoId: string, outPath: string, opts: { keepGps: boolean }): Promise<void>;
}

export interface GradingPorts {
  looks: LookSource;
  renderer: Renderer;
  exports: ExportTarget;
  /** 没接（如单测）就不抄元数据 */
  metadata?: ExportMetadata;
  /** 后台导出同时渲染几张（sharp 自己多线程，缺省 2 张就能吃满 CPU 又不爆内存） */
  concurrency?: number;
}
