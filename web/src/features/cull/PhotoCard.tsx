import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from 'cn';
import { Card } from '@/components/ui/card';
import { source } from '@/api';
import type { Photo } from '@/core/types';

/**
 * 卡片面：**只有照片**，不放任何文字与按钮 —— 压在画面上的信息会挡住观察。
 * 信息与控件由外层（Deck 的信息栏 / 看片台的头部）渲染，卡片把它们的状态往上报。
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
  /** 复位到 1× */
  reset: () => void;
  /** 以卡片中心为锚点放大（默认双击倍数） */
  zoomIn: (scale?: number) => void;
}

export interface ZoomView {
  s: number;
  tx: number;
  ty: number;
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
  zoomApi?: RefObject<ZoomApi | null>;
  /** 缩放状态上报给外层（信息栏要在卡片外显示倍数与复位） */
  onZoom?: (view: ZoomView) => void;
  /** 交互层：叠在后排的卡只作视觉，不接手势 */
  bare?: boolean;
  className?: string;
}

export function PhotoCard({ photo, width, height, zoomApi, onZoom, bare = false, className }: PhotoCardProps) {
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
      reset: () => reset(),
      zoomIn: (scale = DBL_SCALE) => zoomAt(scale, 0, 0, true),
    };
    return () => {
      zoomApi.current = null;
    };
  }, [apply, reset, zoomApi, zoomAt]);

  /* ── 缩放状态上报（外层信息栏显示倍数/复位） ── */
  useEffect(() => {
    onZoom?.(view);
  }, [onZoom, view]);

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

    </Card>
  );
}
