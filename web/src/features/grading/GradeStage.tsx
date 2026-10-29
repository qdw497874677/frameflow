import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RotateCcw, SkipForward } from 'lucide-react';
import { jobSource, source } from '@/api';
import type { Job, Look, LookKindSchema, LookParams } from '@/core/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LutCanvas } from './LutCanvas';
import { LookParamsPanel } from './LookParamsPanel';
import { FrameApprox } from './FrameApprox';
import { FilmCropPreview } from './FilmCropPreview';
import { clampStrength, cycleLook, exportSummary, isExporting, isRawEmbedded, isStageEditable, isOverridden, itemExportLabel, jobDefaults, jobFilm, jobRecipe, filmEffectsOn, parseCube, cubeQuery, paramsForKind, patchParams, recipeOf, reviewProgress, type Lut } from './cube';
import { jobProgressView } from '@/features/jobs/jobActions';

/**
 * 风格设置阶段（grade 任务 running/interrupted 时的工作台）：
 * 先定任务默认风格与配置（配置面板由风格类型的参数模式生成，ADR 0006）→ 逐张过目（可覆盖）→「完成并导出」由服务端套同一份 .cube 写 JPEG。
 * 快捷键：[ ] 换风格、- = 强度、按住 \ 看原图、Enter 通过并下一张、N 跳过、R 重置、Esc 关闭、← → 翻页。
 */
export function GradeStage({ job, busy, onAct }: { job: Job; busy: boolean; onAct: (fn: () => Promise<Job>) => Promise<void> }) {
  const [looks, setLooks] = useState<Look[]>([]);
  const [kinds, setKinds] = useState<LookKindSchema[]>([]);
  const [luts, setLuts] = useState<Record<string, Lut>>({});
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [center, setCenter] = useState({ cx: 0.5, cy: 0.5 });

  useEffect(() => {
    let alive = true;
    jobSource.listLooks().then((list) => alive && setLooks(list), (e) => alive && setError(e instanceof Error ? e.message : String(e)));
    jobSource.listLookKinds().then((list) => alive && setKinds(list), () => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const recipe = jobRecipe(job);
  const schemaOf = useCallback((id: string | null) => (id ? kinds.find((k) => k.kind === looks.find((l) => l.id === id)?.kind) : undefined), [kinds, looks]);
  /** 这个风格在任务配方下的参数（按它的类型归一） */
  const paramsOf = (id: string | null): LookParams => paramsForKind(schemaOf(id), recipe.params);
  /** LUT 按「风格 + 影响 LUT 的参数」缓存：换相纸 / 预设 / 曝光就重取一份 */
  const lutKey = (id: string) => `${id}?${cubeQuery(schemaOf(id), recipe.params)}`;
  const wanted = looks.map((l) => lutKey(l.id)).join('|');
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const key of wanted ? wanted.split('|') : []) {
        if (luts[key]) continue;
        const [id, q] = key.split('?') as [string, string];
        try {
          const lut = parseCube(await jobSource.lookCube(id, q));
          if (alive) setLuts((m) => ({ ...m, [key]: lut }));
        } catch (e) {
          if (alive) setError(`风格 ${id} 加载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const photos = useMemo(() => job.items.filter((i) => i.status !== 'skipped'), [job.items]);
  const defaults = jobDefaults(job);
  const progress = reviewProgress(job);
  const ids = looks.map((l) => l.id);
  const nameOf = (id: string | null) => (id ? looks.find((l) => l.id === id)?.name ?? id : '原图');
  const focused = photos.find((p) => p.id === focus) ?? null;
  const editable = isStageEditable(job);
  const summary = exportSummary(job);
  const exporting = isExporting(job);
  const exportProgress = jobProgressView(job);
  const raws = photos.filter(isRawEmbedded).length;
  const keepGps = job.params?.['keepGps'] === true;
  const film = jobFilm(job);
  const isFilm = (id: string | null) => !!id && looks.find((l) => l.id === id)?.kind === 'film';

  const act = useCallback((name: string, body: Record<string, unknown>) => onAct(() => jobSource.jobAction(job.id, name, body)), [job.id, onAct]);
  const defaultSchema = schemaOf(defaults.look);
  const setDefaultStrength = useCallback((v: number) => (defaultSchema
    ? act('defaults', { recipe: { params: patchParams(defaultSchema, paramsForKind(defaultSchema, recipe.params), 'strength', v) } })
    : act('defaults', { strength: v })), [act, defaultSchema, recipe.params]);
  const move = useCallback((step: number) => {
    if (!photos.length) return;
    const i = Math.max(0, photos.findIndex((p) => p.id === focus));
    setFocus(photos[(i + step + photos.length) % photos.length]!.id);
  }, [photos, focus]);

  useEffect(() => {
    if (!editable) return;
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || busy) return;
      if (e.key === '\\') return setOriginal(true);
      if (!focused) {
        if (e.key === '[' || e.key === ']') void act('defaults', { look: cycleLook(ids, defaults.look, e.key === ']' ? 1 : -1) });
        else if (e.key === '-' || e.key === '=') void setDefaultStrength(clampStrength(defaults.strength + (e.key === '=' ? 0.1 : -0.1)));
        else if (e.key === 'ArrowRight' || e.key === 'Enter') move(0);
        else return;
        e.preventDefault();
        return;
      }
      const r = recipeOf(job, focused);
      const id = focused.id;
      if (e.key === '[' || e.key === ']') void act('set', { photoId: id, look: cycleLook(ids, r.look, e.key === ']' ? 1 : -1) });
      else if (e.key === '-' || e.key === '=') void act('set', { photoId: id, strength: clampStrength(r.strength + (e.key === '=' ? 0.1 : -0.1)) });
      else if (e.key === 'Enter') void act('set', { photoId: id, reviewed: true }).then(() => move(1));
      else if (e.key === 'n' || e.key === 'N') move(1);
      else if (e.key === 'r' || e.key === 'R') void act('set', { photoId: id, reset: true });
      else if (e.key === 'Escape') setFocus(null);
      else if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
      else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => e.key === '\\' && setOriginal(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [editable, busy, focused, job, ids, defaults.look, defaults.strength, act, move, setDefaultStrength]);

  const lutOf = (id: string | null) => (id ? luts[lutKey(id)] ?? null : null);
  const strip = (current: string | null, pick: (id: string | null) => void) => (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {[null, ...ids].map((id) => (
        <button
          key={id ?? 'none'}
          type="button"
          disabled={!editable || busy}
          onClick={() => pick(id)}
          className={cn('shrink-0 rounded-md border px-2 py-1 text-xs', current === id ? 'border-gold text-gold' : 'border-border/60 text-muted-foreground hover:text-foreground')}
          title={id ? looks.find((l) => l.id === id)?.inspiredBy : '不套用'}
        >
          {nameOf(id)}
        </button>
      ))}
    </div>
  );
  const strength = (value: number, set: (v: number) => void) => (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      强度
      <input type="range" min={0} max={1} step={0.1} value={value} disabled={!editable || busy} onChange={(e) => set(Number(e.target.value))} className="w-32 accent-[var(--color-gold,currentColor)]" />
      <span className="w-8 tabular-nums text-foreground">{Math.round(value * 100)}%</span>
    </label>
  );

  return (
    <div className="mt-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">风格设置</p>
        {editable ? (
          <>
            <Badge variant="outline">已过目 {progress.reviewed}/{progress.total}</Badge>
            <span className="text-[11px] text-muted-foreground">没过目的照片按任务默认导出；Enter / 「通过」才算过目</span>
          </>
        ) : exporting ? (
          <>
            <Badge variant="outline" className="border-gold text-gold" data-testid="grade-exporting">
              导出中 {exportProgress.label}{summary.failed ? ` · 失败 ${summary.failed}` : ''}
            </Badge>
            <span className="text-[11px] text-muted-foreground">后台逐张渲染，每张完成即更新；关掉页面也会继续，服务重启后接着跑。配方已锁定</span>
          </>
        ) : (
          <>
            <Badge variant="outline">已导出 {summary.done}{summary.failed ? ` · 失败 ${summary.failed}` : ''}</Badge>
            <span className="text-[11px] text-muted-foreground">任务已收场，下面是最终配方（只读）</span>
          </>
        )}
        {editable && (
          <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void act('complete', {})}>
            <Check className="size-3.5" />
            完成并导出
          </Button>
        )}
      </div>
      {exporting && (
        <span className="mt-2 block h-1 overflow-hidden rounded bg-muted-foreground/20">
          <span className="block h-full rounded bg-gold transition-[width]" style={{ width: `${exportProgress.percent}%` }} />
        </span>
      )}
      {raws > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="grade-raw-notice">
          <Badge variant="outline" className="mr-1 px-1 py-0 text-[10px]">RAW</Badge>
          {raws} 张只有 RAW：预览与成品都用相机机内内嵌的 JPEG（不做 RAW 解码，尺寸与影调以机内 JPEG 为准）
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {editable && <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">任务默认（未选中照片时 [ ] 与 - = 调这里）</p>
        {strip(defaults.look, (id) => void act('defaults', id ? { recipe: { lookId: id } } : { look: null }))}
        {!defaultSchema && strength(defaults.strength, (v) => void setDefaultStrength(v))}
        <label className="flex items-center gap-2 text-xs text-muted-foreground" title="拍摄时间、相机/镜头、作者/版权总会保留；朝向已摆正">
          <input type="checkbox" checked={keepGps} disabled={busy} onChange={(e) => void act('defaults', { keepGps: e.target.checked })} />
          成品保留 GPS 位置（缺省剥掉，外发更安全）
        </label>
        {defaultSchema && <LookParamsPanel schema={defaultSchema} params={paramsOf(defaults.look)} disabled={busy} onChange={(next) => void act('defaults', { recipe: { params: next } })} />}
      </div>}

      {editable && focused && (
        <div className="mt-3 rounded-md border border-border/60 p-2">
          <div
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setCenter({ cx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), cy: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
            }}
          >
          <FrameApprox schema={original ? undefined : schemaOf(recipeOf(job, focused).look)} params={paramsOf(recipeOf(job, focused).look)}>
          <LutCanvas
            src={source.thumbUrl(focused.id, 2048)}
            lut={lutOf(recipeOf(job, focused).look)}
            strength={recipeOf(job, focused).strength}
            original={original}
            alt={focused.displayName ?? focused.id}
            className="block max-h-[60vh] max-w-full object-contain"
          />
          </FrameApprox>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="truncate text-xs">{focused.displayName ?? focused.id}</span>
            {original && <Badge variant="outline">原图</Badge>}
            {isFilm(recipeOf(job, focused).look) && filmEffectsOn(film) && (
              <Badge variant="outline" className="border-gold text-gold" title="预览为 LUT；颗粒/光晕只在导出出现">预览为 LUT · 导出加颗粒/光晕</Badge>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground">按住 \ 对比原图 · Enter 通过 · N 跳过 · Esc 关闭</span>
          </div>
          {isFilm(recipeOf(job, focused).look) && filmEffectsOn(film) && (
            <FilmCropPreview photoId={focused.id} look={recipeOf(job, focused).look!} params={{ ...paramsOf(recipeOf(job, focused).look), strength: recipeOf(job, focused).strength }} center={center} />
          )}
          {strip(recipeOf(job, focused).look, (id) => void act('set', { photoId: focused.id, look: id }))}
          <div className="flex flex-wrap items-center gap-2">
            {strength(recipeOf(job, focused).strength, (v) => void act('set', { photoId: focused.id, strength: v }))}
            <Button size="sm" variant="ghost" disabled={!editable || busy} onClick={() => void act('set', { photoId: focused.id, reset: true })}>
              <RotateCcw className="size-3.5" />
              跟随默认
            </Button>
            <Button size="sm" variant="ghost" onClick={() => move(1)}>
              <SkipForward className="size-3.5" />
              跳过
            </Button>
            <Button size="sm" disabled={!editable || busy} onClick={() => void act('set', { photoId: focused.id, reviewed: true }).then(() => move(1))}>
              <Check className="size-3.5" />
              通过并下一张
            </Button>
          </div>
        </div>
      )}

      <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((it) => {
          const r = recipeOf(job, it);
          return (
            <li key={it.id}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => setFocus(it.id)}
                className={cn('block w-full overflow-hidden rounded-md border text-left', focus === it.id ? 'border-gold' : 'border-border/60')}
              >
                <LutCanvas src={source.thumbUrl(it.id, 512)} lut={lutOf(r.look)} strength={r.strength} original={original} alt={it.displayName ?? it.id} className="aspect-square w-full object-cover" />
                <div className="flex items-center gap-1 px-1.5 py-1 text-[11px]">
                  <span className="truncate">{nameOf(r.look)}{r.look && r.strength < 1 ? ` · ${Math.round(r.strength * 100)}%` : ''}</span>
                  {isOverridden(it) && <span className="text-gold">改</span>}
                  {isRawEmbedded(it) && (
                    <span className="shrink-0 rounded border border-border/60 px-0.5 text-[9px] text-muted-foreground" title="RAW：使用机内内嵌 JPEG">RAW·内嵌</span>
                  )}
                  <span className={cn('ml-auto shrink-0', it.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')} title={it.status === 'failed' ? it.note : undefined}>
                    {itemExportLabel(job, it)}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
