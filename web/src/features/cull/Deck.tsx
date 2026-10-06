import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useTransform, type MotionValue } from 'framer-motion';
import { Maximize2, Minimize2, Star, Trash2 } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import type { Photo } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FOCUS_LABEL, PhotoCard, type ZoomApi, type ZoomView } from './PhotoCard';
import { useDeckPhysics } from './useDeckPhysics';
import { StarRow } from './StarRow';

/**
 * 模式 A：一次专注一张。
 *
 * 层叠是「同一叠牌」而不是三张卡各演各的：
 *   - 拖动进度 progress 是唯一驱动量，后排的亮度/尺寸/纵深都由它连续插值；
 *   - 顶卡飞出与后排顶上共用同一条曲线，所以不会有「突然变亮、突然冒出信息」的硬切；
 *   - 新顶上来的卡先暗后亮地「落定」，和它当后排时是同一副面孔。
 */

interface Frame {
  width: number;
  height: number;
}

function UnderCard({
  photo,
  frame,
  depth,
  progress,
}: {
  photo: Photo;
  frame: Frame;
  depth: 1 | 2;
  progress: MotionValue<number>;
}) {
  const y = useTransform(progress, [0, 1], [0, -8 * depth]);
  const scale = useTransform(progress, [0, 1], [1 - 0.028 * depth, 1.06 - 0.028 * depth]);
  const filter = useTransform(
    progress,
    [0, 1],
    [`brightness(${0.5 - 0.07 * (depth - 1)}) saturate(0.95)`, 'brightness(0.8) saturate(1)'],
  );

  return (
    <motion.div
      className="relative"
      style={{
        gridArea: '1 / 1',
        width: frame.width,
        height: frame.height,
        z: -60 * depth,
        rotateY: depth === 1 ? -2 : 3,
        y,
        scale,
        filter,
        zIndex: 10 - depth,
      }}
    >
      <PhotoCard photo={photo} width={frame.width} height={frame.height} bare />
      <div className="pointer-events-none absolute inset-0 rounded-none bg-background/25" />
    </motion.div>
  );
}

export function Deck() {
  const { items, cursor, entryDir, entryToken, mode, canUndo, flight } = useAppState();
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const zoomApi = useRef<ZoomApi | null>(null);
  const [zoomView, setZoomView] = useState<ZoomView>({ s: 1, tx: 0, ty: 0 });
  const handleZoom = useCallback((v: ZoomView) => {
    setZoomView((prev) => (prev.s === v.s && prev.tx === v.tx && prev.ty === v.ty ? prev : v));
  }, []);

  // 用 callback ref 而不是 useRef + []：加载中这一块是不渲染的（空态），
  // 一次性的 effect 会在那时拿到 null 就再也不量了 —— 舞台尺寸会永远停在 0。
  useEffect(() => {
    if (!stageEl) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setStage({ w: r.width, h: r.height });
    });
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [stageEl]);

  const top = items[cursor];
  const next1 = items[cursor + 1];
  const next2 = items[cursor + 2];

  const frameW = Math.max(0, Math.min(stage.w * 0.94, 900));
  const frameH = Math.max(0, stage.h - 4);
  const fit = (ar: number): Frame => {
    const width = Math.min(frameW, frameH * ar);
    return { width, height: width / Math.max(0.1, ar) };
  };
  const underFrame = (photo: Photo): Frame => {
    const own = fit(photo.ar);
    // 后排不按自己的横竖比撑满取景框，而是以顶卡为基准微放大 —— 否则竖构图会把整叠撑爆
    const k = Math.min(1, (topFrame.width * 1.06) / own.width, (topFrame.height * 1.06) / own.height);
    return { width: own.width * k, height: own.height * k };
  };

  const topFrame = fit(top?.ar ?? 1.5);

  const physics = useDeckPhysics({
    cardWidth: topFrame.width,
    onCommit: (dir, stars, action) => {
      if (action === 'skip') store.skip(dir);
      else store.commitSwipe(dir, stars);
    },
    isZoomed: () => zoomApi.current?.isZoomed() ?? false,
    onPanWhileZoomed: (dx, dy) => zoomApi.current?.pan(dx, dy),
    onPanEnd: () => zoomApi.current?.endPan(),
  });

  const { x, y, rotate, rotateY, progress, likeOpacity, nopeOpacity, likeScale, stars, handlers, flyOut, flyIn } =
    physics;

  // 撤销：让卡片从它离开的方向飞回来
  const seenToken = useRef(entryToken);
  useEffect(() => {
    if (entryToken === seenToken.current) return;
    seenToken.current = entryToken;
    flyIn(entryDir);
  }, [entryDir, entryToken, flyIn]);

  // 键盘流（模式 A）：左手 ←→/F/X/空格，右手 1-5/0
  useEffect(() => {
    if (mode !== 'a') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          store.undo();
        }
        return;
      }
      const k = e.key;
      // Shift + ←/→ 是 App 层的「一个看 ⇄ 批量扫」变焦快捷键，这里让路（否则会顺手把当前张提交掉）
      if (e.shiftKey) return;
      if (k >= '1' && k <= '5') {
        if (top) store.setStars(top.id, Number(k));
      } else if (k === '0') {
        if (top) store.clearMark(top.id);
      } else if (k === 'ArrowRight' || k.toLowerCase() === 'f') {
        e.preventDefault();
        void flyOut(1, stars, 'commit');
      } else if (k === 'ArrowLeft' || k.toLowerCase() === 'x') {
        e.preventDefault();
        void flyOut(-1, 1, 'commit');
      } else if (k === ' ') {
        e.preventDefault();
        void flyOut(1, stars, 'skip');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flyOut, mode, stars, top]);

  if (!top) {
    const liked = items.filter((i) => i.mark.stars > 0).length;
    const trashed = items.filter((i) => i.mark.del).length;
    return (
      <div className="grid h-full place-items-center px-6">
        <Card className="max-w-sm gap-3 p-6 text-center">
          <p className="text-base font-medium">这一批挑完了</p>
          <p className="text-sm text-muted-foreground">
            已标 {liked} 张喜欢、{trashed} 张待删。切到「批量扫」复查一遍，或者在看片台里逐张放大。
          </p>
          <Button variant="outline" size="sm" className="mx-auto" onClick={() => store.undo()} disabled={!canUndo}>
            撤销上一步
          </Button>
        </Card>
      </div>
    );
  }

  const zoomed = zoomView.s > 1.01;
  const focus = top.focusHint && top.focusHint !== 'sharp' ? top.focusHint : null;

  return (
    <div className="flex h-full flex-col">
      <div ref={setStageEl} className="relative min-h-0 flex-1">
        <div className="absolute inset-0" style={{ perspective: 1100, perspectiveOrigin: '50% 45%' }}>
          <div className="absolute inset-0 grid place-items-center" style={{ transformStyle: 'preserve-3d' }}>
            {next2 && <UnderCard photo={next2} frame={underFrame(next2)} depth={2} progress={progress} />}
            {next1 && <UnderCard photo={next1} frame={underFrame(next1)} depth={1} progress={progress} />}

            {/* 顶卡：拖动跟手 + 落定动画 */}
            <motion.div
              className="relative z-30 cursor-grab active:cursor-grabbing"
              style={{ gridArea: '1 / 1', width: topFrame.width, height: topFrame.height, x, y, rotate, rotateY }}
              {...handlers}
            >
              <motion.div
                key={top.id}
                ref={cardRef}
                data-deck-card
                className="size-full"
                style={{ opacity: flight?.id === top.id ? 0 : 1 }}
                initial={{ scale: 0.965, filter: 'brightness(0.55) saturate(0.95)' }}
                animate={{ scale: 1, filter: 'brightness(1) saturate(1)' }}
                transition={{ duration: 0.32, ease: [0.2, 0.8, 0.3, 1] }}
              >
                <PhotoCard
                  photo={top}
                  width={topFrame.width}
                  height={topFrame.height}
                  zoomApi={zoomApi}
                  onZoom={handleZoom}
                />
              </motion.div>

              {/* 盖章：右滑喜欢（带星数）/ 左滑待删 */}
              <motion.div
                style={{ opacity: likeOpacity, scale: likeScale }}
                className="pointer-events-none absolute top-8 left-6 -rotate-9 rounded-lg border-[3px] border-gold px-2.5 py-1 text-xl font-black tracking-widest text-gold"
              >
                留下
                {stars > 1 && <span className="ml-1.5 align-middle text-base">{'★'.repeat(stars)}</span>}
              </motion.div>
              <motion.div
                style={{ opacity: nopeOpacity }}
                className="pointer-events-none absolute top-8 right-6 rotate-9 rounded-lg border-[3px] border-danger px-2.5 py-1 text-xl font-black tracking-widest text-danger"
              >
                待删
              </motion.div>
            </motion.div>
          </div>
        </div>

        {/* 拖动中：让人知道松手会打成几星 */}
      </div>

      {/*
        信息栏：会挡住照片的一切（型号、RAW+JPEG、跑焦角标、张数、放大键）
        都放在卡外这一行 —— 画面里只留照片本身。
      */}
      <div className="flex h-8 shrink-0 items-center justify-center px-2 text-[11px] text-muted-foreground">
        <div className="flex w-full items-center justify-between gap-2" style={{ maxWidth: topFrame.width }}>
        <div className="flex min-w-0 items-center gap-1.5">
          {focus && (
            <span className="shrink-0 rounded-sm bg-danger/15 px-1.5 py-0.5 font-medium text-danger">
              {FOCUS_LABEL[focus] ?? focus}
            </span>
          )}
          {top.kind === 'video' && (
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-foreground/70">视频</span>
          )}
          {top.hasRaw && top.hasJpeg && (
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-foreground/70">RAW+JPEG</span>
          )}
          <span className="truncate">
            {top.camera ?? (top.kind === 'video' ? top.displayName : '')}
            {top.lens ? ` · ${top.lens}` : ''}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {physics.dragging ? (
            stars > 1 ? (
              <span className="flex items-center gap-1 text-gold">
                <Star className="size-3.5 fill-gold" />
                {stars} 星
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Trash2 className="size-3.5" />
                左滑待删
              </span>
            )
          ) : (
            <>
              {zoomed && <span className="tabular-nums text-foreground/70">{Math.round(zoomView.s * 100)}%</span>}
              <span className="tabular-nums">
                {String(cursor + 1).padStart(2, '0')}/{items.length}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                aria-label={zoomed ? '退出放大' : '放大看细节'}
                onClick={() => (zoomed ? zoomApi.current?.reset() : zoomApi.current?.zoomIn())}
              >
                {zoomed ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
            </>
          )}
        </div>
        </div>
      </div>

      <StarRow
        stars={top.mark.stars}
        del={top.mark.del}
        canUndo={canUndo}
        onStar={(n) => (top.mark.stars === n ? store.clearMark(top.id) : store.setStars(top.id, n))}
        onDel={() => store.toggleDel(top.id)}
        onUndo={() => store.undo()}
      />
    </div>
  );
}
