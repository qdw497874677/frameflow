import type { ReactNode } from 'react';
import { cn } from 'cn';
import { useAppState } from '@/core/store';
import { Deck } from '@/features/cull/Deck';
import { Grid } from '@/features/browse/Grid';
import { FlightOverlay } from './FlightOverlay';

/**
 * 舞台：一个看与批量扫同时挂着，切换只是换焦距。
 *
 * 两层都保持挂载（不是条件渲染）：
 *   - 网格要一直有布局，才能在变焦前把当前这张滚到视野中央，让「缩小的起点 = 网格里的落点」；
 *   - 变焦时由 FlightOverlay 拿着一张浮在上层的照片从旧矩形补间到新矩形，
 *     所以同一张照片是连续地缩/长，而不是两个界面互相淡入淡出；
 *   - 隐藏层不可点、不参与无障碍树，键盘与指针事件永远只落在当前这一层；
 *     每层自带不透明底色，所以背后那层不会从缝隙里透出来。
 */
export function Stage() {
  const { mode, loading, items } = useAppState();
  const focus = mode === 'a';

  return (
    <div className="relative h-full overflow-hidden">
      <Layer active={focus}>
        <Deck />
      </Layer>
      <Layer active={!focus}>
        <Grid />
      </Layer>

      <FlightOverlay />

      {loading && items.length === 0 && (
        <div className="absolute inset-0 grid place-items-center bg-background/80 text-sm text-muted-foreground">
          正在读取照片…
        </div>
      )}
    </div>
  );
}

function Layer({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        'absolute inset-0 bg-background transition-opacity ease-out',
        active ? 'z-10 opacity-100 duration-150' : 'pointer-events-none z-0 opacity-0 duration-200',
      )}
    >
      {children}
    </div>
  );
}
