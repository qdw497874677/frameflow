import { useEffect, useRef, useState } from 'react';
import type { Lut } from './cube.ts';
import { lutRenderer } from './lutRenderer.ts';
import { cn } from '@/lib/utils';

/** 一张照片的滤镜预览：图片加载后经共享 WebGL2 渲染器画进 2D canvas */
export function LutCanvas({ src, lut, strength, original = false, className, alt }: {
  src: string;
  lut: Lut | null;
  strength: number;
  original?: boolean;
  className?: string;
  alt?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let alive = true;
    const el = new Image();
    el.decoding = 'async';
    el.onload = () => alive && setImg(el);
    el.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(() => {
    if (!img || !ref.current) return;
    const r = lutRenderer();
    const ctx = ref.current.getContext('2d');
    if (!r) {
      ref.current.width = img.naturalWidth;
      ref.current.height = img.naturalHeight;
      ctx?.drawImage(img, 0, 0);
      return;
    }
    r.draw(img, original ? null : lut, strength, ref.current);
  }, [img, lut, strength, original]);

  return <canvas ref={ref} role="img" aria-label={alt} className={cn('bg-muted', className)} />;
}
