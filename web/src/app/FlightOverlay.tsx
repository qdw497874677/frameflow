import { useLayoutEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { source } from '@/api';
import { store, useAppState, type Rect } from '@/core/store';

/**
 * 变焦途中飞着的那一张。
 *
 * 变焦时把「一个看」和「批量扫」各自的那份都藏起来，只让这一张浮在最上层走完整段路：
 *   起点 = 出发那一层里它的矩形（进网格时是卡片、回卡片流时是格子），
 *   终点 = 目标那一层里它的矩形（切完之后才量得到，所以在这里量）。
 * 用 translate + scale 而不是改宽高：整段动画只有 transform，不触发重排。
 */
export function FlightOverlay() {
  const { flight } = useAppState();
  const [to, setTo] = useState<Rect | null>(null);
  const still = useReducedMotion();

  useLayoutEffect(() => {
    if (!flight) {
      setTo(null);
      return;
    }
    const sel = flight.dir === 1 ? `[data-photo="${CSS.escape(flight.id)}"]` : '[data-deck-card]';
    const el = document.querySelector(sel);
    const r = el?.getBoundingClientRect();
    if (!r || r.width < 1 || r.height < 1) {
      setTo(null);
      store.endFlight();
      return;
    }
    setTo({ x: r.x, y: r.y, w: r.width, h: r.height });
  }, [flight]);

  if (!flight || !to) return null;

  const cx = to.x + to.w / 2 - (flight.from.x + flight.from.w / 2);
  const cy = to.y + to.h / 2 - (flight.from.y + flight.from.h / 2);
  const k = to.w / flight.from.w;

  return (
    <motion.div
      className="pointer-events-none fixed z-50 overflow-hidden rounded-none ring-1 ring-white/10"
      style={{
        left: flight.from.x,
        top: flight.from.y,
        width: flight.from.w,
        height: flight.from.h,
        transformOrigin: 'center',
      }}
      initial={{ x: 0, y: 0, scale: 1 }}
      animate={{ x: cx, y: cy, scale: k }}
      transition={still ? { duration: 0 } : { duration: 0.38, ease: [0.22, 0.9, 0.26, 1] }}
      onAnimationComplete={() => store.endFlight()}
    >
      <img
        src={source.thumbUrl(flight.id, 2048)}
        alt=""
        draggable={false}
        className="size-full object-cover"
      />
    </motion.div>
  );
}
