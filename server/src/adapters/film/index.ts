/**
 * 光谱胶片模块（有边界）：外面只经这个文件用它。
 * 组装：子进程引擎（ProcessFilmEngine）+ 数据目录 LUT 缓存（DirFilmLutStore）→ 应用层 FilmLookSource。
 * 功能开关 `film.enabled` 缺省关；关着时 createFilmModule 不会被调用，服务与以前完全一样。
 */
import type { FilmEngineHealth } from '../../application/grading/ports.ts';
import { FilmLookSource } from '../../application/grading/film-looks.ts';
import type { FilmCfg } from '../outbound/config-file.ts';
import { DirFilmLutStore } from './lut-store.ts';
import { ProcessFilmEngine } from './process-engine.ts';

export { ProcessFilmEngine, EngineError } from './process-engine.ts';
export { encodeFrame, FrameDecoder } from './codec.ts';
export { DirFilmLutStore } from './lut-store.ts';

export interface FilmModule {
  readonly looks: FilmLookSource;
  readonly engine: ProcessFilmEngine;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { enabled: true; engine: FilmEngineHealth; looks: number; catalog: 'engine' | 'cache' | 'none' | 'pending' };
}

export function createFilmModule(cfg: FilmCfg, dataDir: string, log: (msg: string) => void = () => undefined): FilmModule {
  const engine = new ProcessFilmEngine({
    binary: cfg.binary,
    args: ['--data', cfg.stocksDir, ...(cfg.threads > 0 ? ['--threads', String(cfg.threads)] : [])],
    timeoutMs: cfg.timeoutMs,
  });
  const looks = new FilmLookSource(engine, new DirFilmLutStore(dataDir), { lutSize: cfg.lutSize, ...(cfg.paper ? { paper: cfg.paper } : {}) });
  let catalog: 'engine' | 'cache' | 'none' | 'pending' = 'pending';
  return {
    looks,
    engine,
    async start() {
      const r = await looks.refresh();
      catalog = r.from;
      if (r.error) log(`胶片引擎不可用（风格目录来自 ${r.from}）：${r.error}`);
    },
    stop: () => engine.close(),
    status: () => ({ enabled: true, engine: engine.health(), looks: looks.list().length, catalog }),
  };
}
