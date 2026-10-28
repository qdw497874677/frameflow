import { useEffect, useState } from 'react';
import { ZoomIn } from 'lucide-react';
import { jobSource } from '@/api';
import type { FilmEffects } from '@/core/types';
import { Button } from '@/components/ui/button';

/**
 * 100% 裁切预览：让服务端引擎对一块 512×512 真渲染颗粒 / 光晕（约 1 秒），对照 LUT 预览。
 * 中心取上次在大图上点的位置（缺省正中）。颗粒统计与导出一致，具体图样不逐像素一致。
 */
export function FilmCropPreview({ photoId, look, strength, film, center }: { photoId: string; look: string; strength: number; film: FilmEffects; center: { cx: number; cy: number } }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { setUrl(null); setError(null); }, [photoId, look]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await jobSource.filmPreview({ photoId, look, strength, film, ...center, size: 512 });
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-1" data-testid="film-crop-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
          <ZoomIn className="size-3.5" />
          {busy ? '引擎渲染中…' : '100% 裁切预览（真颗粒/光晕）'}
        </Button>
        <span className="text-[11px] text-muted-foreground">点大图选位置；服务端引擎渲染 512×512，与导出同尺度</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {url && <img src={url} alt="100% 裁切预览" className="block h-auto max-w-full rounded border border-border/60" style={{ imageRendering: 'pixelated', width: 512 }} />}
    </div>
  );
}
