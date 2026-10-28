import type { FilmEffects } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { filmEffectsOn, patchFilm } from './cube';

/** 一项效果的滑块：0 = 关 */
interface Knob { key: keyof FilmEffects; label: string; min: number; max: number; step: number; unit?: string; hint: string; fallback: number }

const KNOBS: Knob[] = [
  { key: 'grain', label: '颗粒', min: 0, max: 4, step: 0.25, hint: '按胶片 RMS 颗粒度标定；1 = 数据表颗粒度', fallback: 0 },
  { key: 'halation', label: '光晕', min: 0, max: 1, step: 0.05, hint: '高光透过片基反射回乳剂的红晕', fallback: 0 },
  { key: 'halationRadiusMm', label: '光晕半径', min: 0.02, max: 2, step: 0.02, unit: 'mm', hint: '底片上光晕的高斯 σ（缺省 0.25 mm）', fallback: 0.25 },
  { key: 'dirDiffusionUm', label: 'DIR 边缘', min: 0, max: 100, step: 5, unit: 'µm', hint: 'DIR 抑制剂扩散：边缘锐化 / 邻接效应', fallback: 0 },
  { key: 'filmFormatMm', label: '画幅长边', min: 8, max: 120, step: 1, unit: 'mm', hint: '36 = 135 画幅；越小颗粒越显', fallback: 36 },
];

/**
 * 胶片整帧效果（任务级）：只对光谱胶片风格、只在导出出现。预览一直是 LUT —— 这里写清楚，免得以为没生效。
 */
export function FilmEffectsPanel({ film, disabled, onChange }: { film: FilmEffects; disabled: boolean; onChange: (next: FilmEffects | null) => void }) {
  const on = filmEffectsOn(film);
  return (
    <div className="rounded-md border border-border/60 p-2" data-testid="film-effects">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs">胶片效果（导出）</p>
        {on ? <Badge variant="outline" className="border-gold text-gold">导出时整帧渲染</Badge> : <Badge variant="outline">关</Badge>}
        <span className="text-[11px] text-gold" data-testid="film-effects-notice">颗粒/光晕只在导出出现，预览为 LUT</span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        只对「· 光谱」风格生效；开了以后每张由引擎整帧渲染（18 MP 约 5 秒），再按强度混回。颗粒种子按照片派生，重导结果一致。
      </p>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {KNOBS.map((k) => {
          const v = film[k.key] ?? k.fallback;
          return (
            <label key={k.key} className="flex items-center gap-2 text-xs text-muted-foreground" title={k.hint}>
              <span className="w-16 shrink-0">{k.label}</span>
              <input
                type="range" min={k.min} max={k.max} step={k.step} value={v} disabled={disabled}
                aria-label={k.label}
                onChange={(e) => onChange(patchFilm(film, k.key, Number(e.target.value)))}
                className="w-28 accent-[var(--color-gold,currentColor)]"
              />
              <span className="w-14 tabular-nums text-foreground">{v}{k.unit ? ` ${k.unit}` : ''}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
