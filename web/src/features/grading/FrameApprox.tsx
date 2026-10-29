import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LookKindSchema, LookParams } from '@/core/types';
import { borderLayout, paramValue } from './cube';

/**
 * 边框 / 暗角的预览近似（CSS）：导出时服务端按同一算法真做（frame-extras.ts）。
 * 量出子元素渲染尺寸，按 borderLayout 算出加边后的画布，四周填色；暗角是径向渐变叠层。
 */
export function FrameApprox({ schema, params, children }: { schema: LookKindSchema | undefined; params: LookParams; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null | undefined;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const num = (k: string) => (schema ? Number(paramValue(schema, params, k) ?? 0) : 0);
  const width = num('borderWidth'), vignette = num('vignette');
  const ratio = schema ? String(paramValue(schema, params, 'borderRatio') ?? 'original') : 'original';
  const color = schema ? String(paramValue(schema, params, 'borderColor') ?? '#ffffff') : '#ffffff';
  const on = !!schema && (width > 0 || ratio !== 'original');
  const L = on && size && size.w && size.h ? borderLayout(size.w, size.h, { width, ratio }) : null;
  return (
    <div className="flex justify-center" data-testid="frame-approx">
      <div
        style={L ? { background: color, paddingLeft: L.x, paddingRight: L.width - size!.w - L.x, paddingTop: L.y, paddingBottom: L.height - size!.h - L.y } : undefined}
        className="relative inline-block max-w-full"
      >
        <div ref={ref} className="relative">
          {children}
          {vignette > 0 && (
            <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${(0.65 * vignette).toFixed(3)}) 100%)` }} />
          )}
        </div>
      </div>
    </div>
  );
}
