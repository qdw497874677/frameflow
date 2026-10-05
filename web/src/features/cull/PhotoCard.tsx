import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from 'cn';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { source } from '@/api';
import type { Photo } from '@/core/types';

/**
 * 卡片面：照片 + 必要信息 + 放大查看。
 *
 * 放大不改变布局（卡片框不动），只改变照片在框内的变换，
 * 所以「看的还是这张卡，只是凑近了看」。支持双击、滚轮、双指捏合，
 * 放大后拖动平移（由物理层把拖动委派过来：见 zoomApi.pan）。
 */

export interface ZoomApi {
  isZoomed: () => boolean;
  /** dx/dy 是相对本次拖动起点的**累计**位移 */
  pan: (dx: number, dy: number) => void;
  /** 本次拖动结束，平移锚点复位 */
  endPan: () => void;
}

interface View {
  s: number;
  tx: number;
  ty: number;
}

const DBL_SCALE = 2.5;
const MAX_SCALE = 5;

export const FOCUS_LABEL: Record<string, string> = {
  soft: '偏软',
  miss: '跑焦',
};

interface PhotoCardProps {
  photo: Photo;
  width: number;
  height: number;
  index: number;
  total: number;
  zoomApi?: RefObject<ZoomApi | null>;
  /** 交互层：叠在后排的卡只作视觉，不接手势 */
  bare?: boolean;
  className?: string;
}

export function PhotoCard({ photo, width, height, index, total, zoomApi, bare = false, className }: PhotoCardProps) {
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [smooth, setSmooth] = useState(true);
  const viewRef = useRef(view);
  viewRef.current = view;

  const boxRef = useRef<HTMLDivElement>(null);
  const panAnchor = useRef<View | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; view: View; cx: number; cy: number } | null>(null);

  const clampView = useCallback(
    (next: View): View => {
      const s = Math.min(MAX_SCALE, Math.max(1, next.s));
      const limX = (width * (s - 1)) / 2;
      const limY = (height * (s - 1)) / 2;
      return {
        s,
        tx: Math.min(limX, Math.max(-limX, next.tx)),
        ty: Math.min(limY, Math.max(-limY, next.ty)),
      };
    },
    [width, height],
  );

  const apply = useCallback(
    (next: View, animate: boolean) => {
      setSmooth(animate);
      setView(clampView(next));
    },
    [clampView],
  );

  const reset = useCallback(() => apply({ s: 1, tx: 0, ty: 0 }, true), [apply]);

  /** 以卡片中心为原点的坐标 (px,py) 为锚点缩放到 scale */
  const zoomAt = useCallback(
    (scale: number, px: number, py: number, animate: boolean) => {
      const cur = viewRef.current;
      const ratio = scale / cur.s;
      apply({ s: scale, tx: px - (px - cur.tx) * ratio, ty: py - (py - cur.ty) * ratio }, animate);
    },
    [apply],
  );

  /* ── 把缩放能力借给物理层（放大时拖动 = 平移而不是滑卡） ── */
  useEffect(() => {
    if (!zoomApi) return;
    zoomApi.current = {
      isZoomed: () => viewRef.current.s > 1.01,
      pan: (dx, dy) => {
        if (pointers.current.size > 1) return; // 捏合中不平移
        const anchor = panAnchor.current ?? viewRef.current;
        panAnchor.current = anchor;
        apply({ ...anchor, tx: anchor.tx + dx, ty: anchor.ty + dy }, false);
      },
      endPan: () => {
        panAnchor.current = null;
      },
    };
    return () => {
      zoomApi.current = null;
    };
  }, [apply, zoomApi]);

  /* ── 滚轮（要 preventDefault，必须非被动监听） ── */
  useEffect(() => {
    const el = boxRef.current;
    if (!el || bare) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - (rect.left + rect.width / 2);
      const py = e.clientY - (rect.top + rect.height / 2);
      const cur = viewRef.current;
      const next = Math.min(MAX_SCALE, Math.max(1, cur.s * Math.exp(-e.deltaY * 0.0015)));
      if (Math.abs(next - cur.s) < 0.002) return;
      e.preventDefault();
      zoomAt(next, px, py, false);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bare, zoomAt]);

  /* ── 双指捏合（窗口级监听：物理层已用 pointer capture 拿走卡片上的事件） ── */
  useEffect(() => {
    if (bare) return;
    const two = () => [...pointers.current.values()].slice(0, 2);
    const startPinch = () => {
      const [a, b] = two();
      if (!a || !b) return;
      const el = boxRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      pinch.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        view: viewRef.current,
        cx: (a.x + b.x) / 2 - (rect.left + rect.width / 2),
        cy: (a.y + b.y) / 2 - (rect.top + rect.height / 2),
      };
    };
    const updatePinch = () => {
      const p = pinch.current;
      const [a, b] = two();
      if (!p || !a || !b) return;
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const next = Math.min(MAX_SCALE, Math.max(1, p.view.s * (dist / p.dist)));
      const ratio = next / p.view.s;
      apply(
        { s: next, tx: p.cx - (p.cx - p.view.tx) * ratio, ty: p.cy - (p.cy - p.view.ty) * ratio },
        false,
      );
    };
    const down = (e: PointerEvent) => {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) startPinch();
    };
    const move = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size >= 2) updatePinch();
    };
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinch.current = null;
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [apply, bare]);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (bare) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - (rect.left + rect.width / 2);
      const py = e.clientY - (rect.top + rect.height / 2);
      if (viewRef.current.s > 1.01) reset();
      else zoomAt(DBL_SCALE, px, py, true);
    },
    [bare, reset, zoomAt],
  );

  const zoomed = view.s > 1.01;
  const focus = photo.focusHint && photo.focusHint !== 'sharp' ? photo.focusHint : null;
  const winPct = 100 / view.s;
  const rectLeft = 50 - winPct / 2 - (view.tx * 100) / (view.s * Math.max(1, width));
  const rectTop = 50 - winPct / 2 - (view.ty * 100) / (view.s * Math.max(1, height));

  return (
    <Card
      className={cn('relative size-full overflow-hidden rounded-none border-0 bg-card p-0 ring-1 ring-white/10', className)}
      style={{ width, height }}
    >
      <div
        ref={boxRef}
        onDoubleClick={onDoubleClick}
        className="absolute inset-0 touch-none overflow-hidden select-none"
      >
        <img
          src={source.thumbUrl(photo.id, 2048)}
          alt={photo.displayName}
          draggable={false}
          className="absolute inset-0 size-full object-cover"
          style={{
            transform: `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.s})`,
            transition: smooth ? 'transform 0.25s cubic-bezier(0.22, 0.9, 0.3, 1)' : 'none',
          }}
        />
      </div>

      {!bare && (
        <>
          {/* 信息 chips：只留最必要的三条，其余交给看片台 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {photo.hasRaw && photo.hasJpeg && (
                <Badge className="bg-black/55 text-[11px] text-foreground/90 backdrop-blur-sm">RAW+JPEG</Badge>
              )}
              {photo.camera && (
                <Badge className="bg-black/55 text-[11px] text-foreground/90 backdrop-blur-sm">
                  {photo.camera}
                  {photo.lens ? ` · ${photo.lens}` : ''}
                </Badge>
              )}
            </div>
            <Badge className="bg-black/55 text-[11px] tabular-nums text-foreground/90 backdrop-blur-sm">
              {String(index + 1).padStart(2, '0')}/{total}
            </Badge>
          </div>

          {focus && (
            <Badge className="absolute bottom-2.5 left-2.5 gap-1 bg-danger/90 text-[11px] font-medium text-white">
              {FOCUS_LABEL[focus] ?? focus}
            </Badge>
          )}

          {zoomed ? (
            <button
              type="button"
              onClick={reset}
              aria-label={`退出放大（${Math.round(view.s * 100)}%）`}
              className="absolute right-2.5 bottom-2.5 size-[74px] overflow-hidden rounded-none ring-1 ring-white/15"
            >
              <img
                src={source.thumbUrl(photo.id, 512)}
                alt=""
                className="size-full object-cover opacity-75"
                draggable={false}
              />
              <span
                className="absolute border border-gold bg-gold/15"
                style={{ left: `${rectLeft}%`, top: `${rectTop}%`, width: `${winPct}%`, height: `${winPct}%` }}
              />
              <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[10px] tabular-nums text-foreground/90">
                {Math.round(view.s * 100)}%
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => zoomAt(DBL_SCALE, 0, 0, true)}
              aria-label="放大看细节"
              className="absolute right-2.5 bottom-2.5 grid size-9 place-items-center rounded-full bg-black/50 text-foreground/85 backdrop-blur-sm transition-colors hover:bg-black/70"
            >
              <Maximize2 className="size-4" />
            </button>
          )}
          {zoomed && (
            <span className="pointer-events-none absolute top-2.5 left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-foreground/85 backdrop-blur-sm sm:flex">
              <Minimize2 className="size-3" />双指/滚轮缩放 · 拖动平移
            </span>
          )}
        </>
      )}
    </Card>
  );
}
