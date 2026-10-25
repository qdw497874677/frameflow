import { useCallback, useEffect, useState } from 'react';
import { connectorsApi, deliveryApi, describeConnectorError, ConnectorApiError } from '@/api/connectors';
import type { ConnectorDto, DeliveryPartDto } from '@/api/contract';
import { Button } from '@/components/ui/button';

const STATE_TEXT: Record<string, string> = {
  pending: '等待发送', sending: '发送中', sent: '已送达', failed: '失败', unknown: '状态未知', cancelled: '已取消',
};

/** 任务详情里的外传状态：按目标分行；失败可重试，状态未知需确认重复风险后才可重试 */
export function DeliveryStatus({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<DeliveryPartDto[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorDto[]>([]);
  const [risk, setRisk] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await deliveryApi.deliveries(jobId)).items); } catch { setItems(null); }
  }, [jobId]);
  useEffect(() => {
    void load();
    connectorsApi.listAll().then((r) => setConnectors(r.items), () => undefined);
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!items || items.length === 0) return null;
  const groups = new Map<string, DeliveryPartDto[]>();
  for (const p of items) {
    const k = `${p.connectorId}/${p.targetId}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const labelOf = (c: string, t: string) => {
    const x = connectors.find((y) => y.id === c);
    return `${x?.label ?? c} · ${x?.targets.find((y) => y.id === t)?.label ?? t}`;
  };
  const retry = async (connectorId: string, targetId: string, accept: boolean) => {
    setBusy(true); setMsg(null);
    try {
      setItems((await deliveryApi.retry(jobId, { connectorId, targetId }, accept)).items);
      setRisk(null);
      setMsg('已重新排队发送');
    } catch (e) {
      if (e instanceof ConnectorApiError && e.code === 'DUPLICATE_RISK') setRisk(`${connectorId}/${targetId}`);
      setMsg(describeConnectorError(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-3 min-w-0 rounded-lg border border-border/60 p-3 text-xs" data-testid="delivery-status">
      <p className="text-sm">外传状态</p>
      <div role="status" aria-live="polite" className="text-muted-foreground">{msg}</div>
      <ul className="mt-2 space-y-2">
        {[...groups].map(([k, parts]) => {
          const [c, t] = k.split('/');
          const failed = parts.some((p) => p.state === 'failed');
          const unknown = parts.some((p) => p.state === 'unknown');
          const state = unknown ? 'unknown' : failed ? 'failed' : parts.every((p) => p.state === 'sent') ? 'sent' : parts.find((p) => p.state !== 'sent')!.state;
          return (
            <li key={k} className="min-w-0 space-y-1" data-testid="delivery-row" data-state={state}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all">{labelOf(c, t)}</span>
                <span className={state === 'sent' ? 'text-ok' : state === 'failed' || state === 'unknown' ? 'text-destructive' : 'text-muted-foreground'}>{STATE_TEXT[state] ?? state}</span>
                {parts.find((p) => p.error)?.error && <span className="break-all text-muted-foreground">（{parts.find((p) => p.error)!.error}）</span>}
              </div>
              {(failed || unknown) && (
                <div className="flex flex-wrap gap-2">
                  {risk === k ? (
                    <>
                      <span className="w-full text-destructive">这条消息可能已经送达；重试可能让对方收到两条。</span>
                      <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => void retry(c, t, true)}>仍然重试（接受重复风险）</Button>
                      <Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => setRisk(null)}>不重试</Button>
                    </>
                  ) : (
                    <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => unknown ? setRisk(k) : void retry(c, t, false)}>重试</Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
