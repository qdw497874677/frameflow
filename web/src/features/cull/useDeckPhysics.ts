import { useCallback, useMemo, useRef, useState } from 'react';
import { animate, useMotionValue, useTransform, type MotionValue } from 'framer-motion';

/**
 * 卡片流的物理层：把「拖动进度 → 后排队形 → 松手释放」做成一件事。
 *
 * 三条真实感来源（对应票 006 的结论）都在这里：
 *  1. progress：拖动进度是唯一驱动量，后排队形由它连续插值（不是松手才动）；
 *  2. release：松手用速度参与的弹簧积分，而不是 CSS transition；
 *  3. flight：飞出与顶上共用同一条 progress 曲线（顶卡飞多远，后排就到位多少）。
 */

const STAR_STEP = 95; // 每加一颗星需要下压的像素（用户实测调过：先 70，再 95）
const SNAP_STIFFNESS = 420;
const SNAP_DAMPING = 30;
const FLY_STIFFNESS = 110;
const FLY_DAMPING = 20;

export interface DeckPhysicsOptions {
  /** 当前卡片宽度，用于阈值与飞行距离 */
  cardWidth: number;
  /**
   * 松手越过阈值（或键盘/按钮触发飞行）：dir 1 = 右滑喜欢，-1 = 左滑待删。
   * action 'skip' 表示「只是路过」——跳过这张，不写标记。
   */
  onCommit: (dir: 1 | -1, stars: number, action: 'commit' | 'skip') => void;
  /** 放大态下的平移委派（dx/dy 是相对拖动起点的累计位移） */
  onPanWhileZoomed?: (dx: number, dy: number) => void;
  /** 放大态下本次拖动结束（平移锚点复位） */
  onPanEnd?: () => void;
  isZoomed?: () => boolean;
  /** 卡片宽度变化时重算阈值（由调用方传入，保证阈值随布局更新） */
  onStarsChange?: (stars: number) => void;
}

export interface DeckPhysics {
  x: MotionValue<number>;
  y: MotionValue<number>;
  rotate: MotionValue<number>;
  rotateY: MotionValue<number>;
  /** 拖离进度 0..1：后排卡片用它插值亮度/尺寸/纵深 */
  progress: MotionValue<number>;
  likeOpacity: MotionValue<number>;
  nopeOpacity: MotionValue<number>;
  likeScale: MotionValue<number>;
  stars: number;
  dragging: boolean;
  threshold: number;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
  /** 撤销/回退：卡片从指定方向飞回 */
  flyIn: (dir: -1 | 0 | 1) => void;
  /** 程序化滑出（键盘 F / X / 空格、按钮） */
  flyOut: (dir: 1 | -1, stars?: number, action?: 'commit' | 'skip') => Promise<void>;
  /** 立刻把位移清零（换卡后） */
  resetHard: () => void;
}

function animateTo(mv: MotionValue<number>, target: number, options: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    animate(mv, target, { ...options, onComplete: () => resolve() });
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function useDeckPhysics(options: DeckPhysicsOptions): DeckPhysics {
  const { cardWidth, onCommit, onPanWhileZoomed, onPanEnd, isZoomed, onStarsChange } = options;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [stars, setStars] = useState(1);
  const [dragging, setDragging] = useState(false);

  const widthRef = useRef(cardWidth);
  widthRef.current = cardWidth;

  const drag = useRef<{
    id: number;
    x0: number;
    y0: number;
    lastX: number;
    lastY: number;
    lastT: number;
    vx: number;
  } | null>(null);

  const threshold = useMemo(() => Math.min(95, Math.max(48, cardWidth * 0.22)), [cardWidth]);

  // 拖动进度：唯一驱动量
  const progress = useTransform([x, y], ([vx, vy]: number[]) =>
    clamp(Math.hypot(vx, vy * 0.65) / Math.max(1, threshold), 0, 1),
  );

  const rotate = useTransform(x, (v) => clamp((v / Math.max(1, widthRef.current * 1.2)) * 14, -16, 16));
  const rotateY = useTransform(x, (v) => clamp((v / Math.max(1, widthRef.current * 1.2)) * 16, -18, 18));

  const likeOpacity = useTransform(x, (v) => clamp((v - 20) / 110, 0, 1));
  const nopeOpacity = useTransform(x, (v) => clamp((-v - 20) / 110, 0, 1));
  const likeScale = useTransform(x, (v) => 0.92 + clamp((v - 20) / 400, 0, 0.22));

  const updateStars = useCallback(
    (dy: number) => {
      const next = clamp(1 + Math.max(0, Math.round(dy / STAR_STEP)), 1, 5);
      setStars((prev) => {
        if (prev !== next) onStarsChange?.(next);
        return next;
      });
    },
    [onStarsChange],
  );

  const resetHard = useCallback(() => {
    drag.current = null;
    x.set(0);
    y.set(0);
    setDragging(false);
    setStars(1);
  }, [x, y]);

  const springBack = useCallback(() => {
    const vx = drag.current?.vx ?? 0;
    drag.current = null;
    setDragging(false);
    void Promise.all([
      animateTo(x, 0, { type: 'spring', stiffness: SNAP_STIFFNESS, damping: SNAP_DAMPING, velocity: vx }),
      animateTo(y, 0, { type: 'spring', stiffness: SNAP_STIFFNESS, damping: SNAP_DAMPING }),
    ]).then(() => setStars(1));
  }, [x, y]);

  const flyOut = useCallback(
    async (dir: 1 | -1, starsOverride?: number, action: 'commit' | 'skip' = 'commit') => {
      const distance = Math.max(window.innerWidth, 480) * 1.15;
      const vx = drag.current?.vx ?? dir * 900;
      drag.current = null;
      setDragging(false);
      await Promise.all([
        animateTo(x, dir * distance, {
          type: 'spring',
          stiffness: FLY_STIFFNESS,
          damping: FLY_DAMPING,
          velocity: vx,
        }),
        animateTo(y, y.get() * 1.1, { type: 'spring', stiffness: FLY_STIFFNESS, damping: FLY_DAMPING }),
      ]);
      onCommit(dir, starsOverride ?? stars, action);
      resetHard();
    },
    [onCommit, resetHard, stars, x, y],
  );

  const flyIn = useCallback(
    (dir: -1 | 0 | 1) => {
      drag.current = null;
      if (dir === 0) {
        resetHard();
        return;
      }
      y.set(0);
      x.set(dir * Math.max(240, widthRef.current * 0.9));
      void animateTo(x, 0, { type: 'spring', stiffness: 240, damping: 26, velocity: dir * 400 });
    },
    [resetHard, x, y],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (drag.current) return;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      drag.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        lastT: performance.now(),
        vx: 0,
      };
      setDragging(true);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;

      const now = performance.now();
      const dt = Math.max(1, now - d.lastT);
      d.vx = ((e.clientX - d.lastX) / dt) * 1000;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.lastT = now;

      if (isZoomed?.()) {
        onPanWhileZoomed?.(dx, dy);
        return;
      }

      x.set(dx);
      y.set(dy);
      if (dx > 40) updateStars(dy);
    },
    [isZoomed, onPanWhileZoomed, updateStars, x, y],
  );

  const endPointer = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (isZoomed?.()) {
        drag.current = null;
        setDragging(false);
        onPanEnd?.();
        return;
      }
      if (dx > threshold) void flyOut(1);
      else if (dx < -threshold) void flyOut(-1);
      else springBack();
    },
    [flyOut, isZoomed, onPanEnd, springBack, threshold],
  );

  return {
    x,
    y,
    rotate,
    rotateY,
    progress,
    likeOpacity,
    nopeOpacity,
    likeScale,
    stars,
    dragging,
    threshold,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    },
    flyIn,
    flyOut,
    resetHard,
  };
}
