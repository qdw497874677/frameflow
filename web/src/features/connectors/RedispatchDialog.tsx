import { useEffect, useRef, useState } from 'react';
import { connectorsApi, deliveryApi, describeConnectorError, newRequestId } from '@/api/connectors';
import type { ConnectorDto, DeliveryAppendPreviewDto, DeliveryTargetRefDto } from '@/api/contract';
import { Button } from '@/components/ui/button';

const keyOf = (t: DeliveryTargetRefDto) => `${t.connectorId}/${t.targetId}`;

/**
 * 任务详情「追加投递目标」（F29b）：选择新目标 → 预览（零发送）→ 二次确认 → 只给新目标发。
 * 绑定原任务 jobId，不重建任务、不动 items/确认进度；requestId 在预览时生成，重复点确认复用它。
 */
export function RedispatchDialog({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [connectors, setConnectors] = useState<ConnectorDto[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notify, setNotify] = useState(false);
  const [preview, setPreview] = useState<DeliveryAppendPreviewDto | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const reqId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    deliveryApi.deliveries(jobId).then(
      (r) => { if (live) { setEligible(true); setExisting(new Set(r.items.map((p) => keyOf(p)))); } },
      () => { if (live) setEligible(false); },
    );
    return () => { live = false; };
  }, [jobId, open]);

  if (!eligible) return null;

  const start = async () => {
    setOpen(true); setMsg(null); setPreview(null); setPicked(new Set()); setAck(false);
    try { setConnectors((await connectorsApi.listAll()).items.filter((c) => c.enabled)); } catch (e) { setMsg(describeConnectorError(e)); }
  };
  const close = async () => {
    // 取消：只丢弃预览，零发送
    if (preview) await deliveryApi.cancelPreview(preview.previewId).catch(() => undefined);
    setOpen(false); setPreview(null); reqId.current = null;
  };
  const doPreview = async () => {
    setBusy(true); setMsg(null);
    try {
      const targets = [...picked].map((k) => { const [connectorId, targetId] = k.split('/'); return { connectorId: connectorId!, targetId: targetId! }; });
      setPreview(await deliveryApi.appendPreview(jobId, targets));
      reqId.current = newRequestId();
      setAck(false);
    } catch (e) { setMsg(describeConnectorError(e)); } finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview || !reqId.current) return;
    setBusy(true); setMsg(null);
    try {
      const r = await deliveryApi.appendConfirm(jobId, { previewId: preview.previewId, revision: preview.revision, requestId: reqId.current, notifyOnComplete: notify, acknowledged: true });
      setMsg(r.replayed ? '已追加（重复确认，未重复发送）' : `已追加 ${r.targets.length} 个目标，只发给新增目标`);
      setOpen(false); setPreview(null); reqId.current = null;
    } catch (e) { setMsg(describeConnectorError(e)); } finally { setBusy(false); }
  };

  const options = connectors.flatMap((c) => c.targets.map((t) => ({ k: keyOf({ connectorId: c.id, targetId: t.id }), label: `${c.label} · ${t.label}` })));
  return (
    <div className="mt-3 min-w-0 rounded-lg border border-border/60 p-3 text-xs" data-testid="redispatch">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">追加投递目标</p>
        {!open && <Button className="min-h-11" variant="outline" onClick={() => void start()} data-testid="redispatch-open">追加目标…</Button>}
      </div>
      <div role="status" aria-live="polite" className="text-muted-foreground" data-testid="redispatch-msg">{msg}</div>
      {open && !preview && (
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">给本任务（{jobId}）再派发到新的群/私聊；已有目标不会重复发送。这不是重新创建任务。</p>
          <ul className="space-y-1">
            {options.map((o) => (
              <li key={o.k}>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" disabled={existing.has(o.k)} checked={picked.has(o.k)} data-testid="redispatch-target" data-key={o.k}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(o.k); else n.delete(o.k); return n; })} />
                  <span className="break-all">{o.label}{existing.has(o.k) ? '（已在任务中）' : ''}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />完成时也通知新增目标</label>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={busy || picked.size === 0} onClick={() => void doPreview()} data-testid="redispatch-preview">预览</Button>
            <Button className="min-h-11" variant="ghost" onClick={() => void close()} data-testid="redispatch-cancel">取消</Button>
          </div>
        </div>
      )}
      {open && preview && (
        <div className="mt-2 space-y-2" data-testid="redispatch-review">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">原任务</dt><dd className="break-all">{jobId}（{preview.photoCount} 张，进度不变）</dd>
            <dt className="text-muted-foreground">已有目标</dt><dd className="break-all">{preview.existingTargets.map((t) => t.label).join('、') || '无'}</dd>
            <dt className="text-muted-foreground">新增目标</dt><dd className="break-all" data-testid="redispatch-new">{preview.targets.map((t) => t.label).join('、')}</dd>
            <dt className="text-muted-foreground">外传内容</dt><dd>任务入口卡片（张数/别名/说明）；不含原图，原图需在飞书里另行显式请求</dd>
            <dt className="text-muted-foreground">完成通知</dt><dd>{notify ? '新增目标也会收到' : '新增目标不接收'}</dd>
          </dl>
          <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="redispatch-ack" />我确认将任务信息外传到以上新增目标</label>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={busy || !ack} onClick={() => void confirm()} data-testid="redispatch-confirm">确认追加外传</Button>
            <Button className="min-h-11" variant="ghost" onClick={() => void close()} data-testid="redispatch-cancel">取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}
