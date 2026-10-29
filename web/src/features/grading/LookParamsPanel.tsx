import type { LookKindSchema, LookParams, ParamDescriptor } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { patchParams } from './cube';

const PREVIEW_NOTE: Record<ParamDescriptor['preview'], string> = { lut: '', approx: '预览近似', export: '仅导出' };

/** 一个参数的控件：按模式的类型选（滑块 / 下拉 / 勾选 / 取色 / 种子输入） */
function Control({ d, value, disabled, set }: { d: ParamDescriptor; value: unknown; disabled: boolean; set: (v: number | string | boolean | null) => void }) {
  const cls = 'text-xs';
  switch (d.type) {
    case 'number': {
      const v = typeof value === 'number' ? value : d.default;
      return (
        <>
          <input type="range" min={d.min} max={d.max} step={d.step} value={v} disabled={disabled} aria-label={d.label} onChange={(e) => set(Number(e.target.value))} className="w-28 accent-[var(--color-gold,currentColor)]" />
          <span className="w-16 tabular-nums text-foreground">{d.key === 'strength' ? `${Math.round(v * 100)}%` : `${v}${d.unit ? ` ${d.unit}` : ''}`}</span>
        </>
      );
    }
    case 'enum':
      return (
        <select value={typeof value === 'string' ? value : d.default} disabled={disabled} aria-label={d.label} onChange={(e) => set(e.target.value)} className={`${cls} rounded border border-border/60 bg-background px-1 py-0.5 text-foreground`}>
          {d.options.map((o) => <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>)}
        </select>
      );
    case 'bool':
      return <input type="checkbox" checked={typeof value === 'boolean' ? value : d.default} disabled={disabled} aria-label={d.label} onChange={(e) => set(e.target.checked)} />;
    case 'color':
      return <input type="color" value={typeof value === 'string' ? value : d.default} disabled={disabled} aria-label={d.label} onChange={(e) => set(e.target.value)} className="h-5 w-8 rounded border border-border/60 bg-transparent" />;
    case 'seed':
      return (
        <input type="number" min={0} max={4294967295} step={1} placeholder="按照片" value={typeof value === 'number' ? value : ''} disabled={disabled} aria-label={d.label}
          onChange={(e) => set(e.target.value === '' ? null : Math.trunc(Number(e.target.value)))} className={`${cls} w-24 rounded border border-border/60 bg-background px-1 py-0.5 text-foreground`} />
      );
  }
}

/**
 * 风格配置面板：完全由风格类型的参数模式生成（GET /look-kinds），每个类型自己定义有哪些分组与配置项。
 * 改动整体写回任务默认配方（defaults.recipe.params）。
 */
export function LookParamsPanel({ schema, params, disabled, onChange }: { schema: LookKindSchema; params: LookParams; disabled: boolean; onChange: (next: LookParams) => void }) {
  return (
    <div className="rounded-md border border-border/60 p-2" data-testid="look-params" data-kind={schema.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs">风格配置</p>
        <Badge variant="outline">{schema.label}</Badge>
        <span className="text-[11px] text-muted-foreground">「预览近似」导出时由服务端真做；「仅导出」可用 100% 裁切预览查看</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {schema.groups.map((g) => {
          const items = schema.params.filter((p) => p.group === g.id);
          if (!items.length) return null;
          return (
            <fieldset key={g.id} className="rounded border border-border/40 p-1.5" data-group={g.id}>
              <legend className="px-1 text-[11px] text-muted-foreground" title={g.hint}>
                {g.label}{g.extra ? <span className="ml-1 text-gold">附加</span> : null}
              </legend>
              <div className="space-y-1">
                {items.map((d) => (
                  <label key={d.key} className="flex items-center gap-2 text-xs text-muted-foreground" title={d.hint}>
                    <span className="w-16 shrink-0">{d.label}</span>
                    <Control d={d} value={params[d.key]} disabled={disabled} set={(v) => onChange(patchParams(schema, params, d.key, v))} />
                    {PREVIEW_NOTE[d.preview] && <span className="text-[10px] text-muted-foreground/70">{PREVIEW_NOTE[d.preview]}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
