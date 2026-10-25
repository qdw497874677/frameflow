import { useCallback, useEffect, useState } from 'react';
import { deliveryApi, describeConnectorError } from '@/api/connectors';
import type { ConnectorDto, DeliveryEventDto, DeliveryPolicyDto, DeliveryTargetRefDto } from '@/api/contract';
import { Button } from '@/components/ui/button';

const EVENT_TEXT: Record<DeliveryEventDto, string> = { 'task.dispatched': '派发时', 'task.completed': '完成时' };
const keyOf = (t: DeliveryTargetRefDto) => `${t.connectorId}/${t.targetId}`;

/**
 * 投递策略：按「项目 + 事件」推荐目标。策略只是推荐——派发默认仍仅应用内，用户在派发框里勾选才外传。
 * 只能引用已配置并授权给该项目的目标；不接受任意 chat_id。
 */
export function PolicyEditor({ connectors, projects }: { connectors: ConnectorDto[]; projects: Array<{ id: string; label: string }> }) {
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<DeliveryPolicyDto[]>([]);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [event, setEvent] = useState<DeliveryEventDto>('task.dispatched');
  const [picked, setPicked] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { const r = await deliveryApi.policies(); setRevision(r.revision); setItems(r.items); } catch (e) { setMsg({ kind: 'error', text: describeConnectorError(e) }); }
  }, []);
  useEffect(() => { void reload(); }, [reload, connectors]);

  const allowed = connectors.flatMap((c) => c.targets.filter((t) => t.projectIds.includes(projectId)).map((t) => ({ connectorId: c.id, targetId: t.id, label: `${c.label} · ${t.label}` })));
  const labelOf = (t: DeliveryTargetRefDto) => {
    const c = connectors.find((x) => x.id === t.connectorId);
    return `${c?.label ?? t.connectorId} · ${c?.targets.find((x) => x.id === t.targetId)?.label ?? t.targetId}`;
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ kind: 'ok', text: await fn() }); } catch (e) { setMsg({ kind: 'error', text: describeConnectorError(e) }); } finally { setBusy(false); await reload(); }
  };
  const add = () => run(async () => {
    let n = items.length + 1;
    while (items.some((p) => p.id === `p${n}`)) n++;
    const targets = allowed.filter((t) => picked.includes(keyOf(t))).map(({ connectorId, targetId }) => ({ connectorId, targetId }));
    await deliveryApi.createPolicy(revision, { id: `p${n}`, enabled: true, projectIds: [projectId], event, targets });
    setPicked([]);
    return '策略已保存（保存不会发送任何消息）';
  });

  return (
    <section className="min-w-0 space-y-2 rounded-lg border border-border/60 p-2" data-testid="policy-editor" aria-label="投递策略">
      <p className="font-medium">投递策略（推荐目标）</p>
      <p className="text-muted-foreground">策略只决定派发框里推荐哪些目标；派发默认仅应用内，勾选后才外传。</p>
      {items.map((p) => (
        <div key={p.id} className="min-w-0 space-y-1 rounded border border-border/60 p-2" data-testid="policy-row">
          <div className="break-all">
            {p.projectIds.map((id) => projects.find((x) => x.id === id)?.label ?? id).join('、')} · {EVENT_TEXT[p.event]} · {p.targets.length ? p.targets.map(labelOf).join('、') : '仅应用内'}{p.enabled ? '' : '（已停用）'}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => run(async () => { await deliveryApi.patchPolicy(p.id, revision, { enabled: !p.enabled }); return p.enabled ? '策略已停用' : '策略已启用'; })}>{p.enabled ? '停用策略' : '启用策略'}</Button>
            <Button className="min-h-11 text-destructive" variant="ghost" disabled={busy} onClick={() => run(async () => { await deliveryApi.removePolicy(p.id, revision); return '策略已删除'; })}>删除策略</Button>
          </div>
        </div>
      ))}
      <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
        <label className="min-w-0 text-[11px]">项目
          <select className="h-11 w-full rounded-md border bg-background px-2" aria-label="策略项目" value={projectId} onChange={(e) => { setProjectId(e.target.value); setPicked([]); }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="min-w-0 text-[11px]">事件
          <select className="h-11 w-full rounded-md border bg-background px-2" aria-label="策略事件" value={event} onChange={(e) => setEvent(e.target.value as DeliveryEventDto)}>
            <option value="task.dispatched">派发时</option>
            <option value="task.completed">完成时</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-x-3" role="group" aria-label="策略目标">
        {allowed.length === 0 && <span className="text-muted-foreground">该项目没有已授权的目标</span>}
        {allowed.map((t) => (
          <label key={keyOf(t)} className="flex min-h-11 items-center gap-1">
            <input type="checkbox" className="size-5" checked={picked.includes(keyOf(t))} onChange={(e) => setPicked(e.target.checked ? [...picked, keyOf(t)] : picked.filter((x) => x !== keyOf(t)))} />
            {t.label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11" variant="outline" disabled={busy || !projectId} onClick={() => void add()}>添加策略</Button>
        <div role="status" aria-live="polite" className={msg?.kind === 'error' ? 'text-destructive' : 'text-ok'}>{msg?.text}</div>
      </div>
    </section>
  );
}
