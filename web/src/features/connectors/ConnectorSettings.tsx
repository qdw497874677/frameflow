import { useCallback, useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { connectorsApi, describeConnectorError, ConnectorApiError } from '@/api/connectors';
import type { ConnectorDto, ConnectorInstanceInputDto } from '@/api/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TargetEditor } from './TargetEditor';
import { PolicyEditor } from './PolicyEditor';

type Draft = ConnectorInstanceInputDto;
const STATE_TEXT: Record<string, string> = { disabled: '未启用', connecting: '连接中', connected: '已连接', degraded: '部分可用', error: '出错' };
const parseCsv = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

function blank(existing: ConnectorDto[]): Draft {
  let n = existing.length + 1;
  while (existing.some((c) => c.id === `feishu${n}`)) n++;
  return { id: `feishu${n}`, kind: 'feishu', label: '飞书', appId: '', secretEnv: 'FRAMEFLOW_FEISHU_APP_SECRET', tenantId: null, targets: [], creatorActorIds: [], creatorProjectIds: [] };
}
function toDraft(c: ConnectorDto): Draft {
  const { enabled: _e, secretConfigured: _s, status: _st, ...rest } = c;
  return rest;
}

/**
 * 设置页「外部连接器」：配置实例与目标，默认停用。Secret 只填环境变量名，不在网页里录入。
 * 未认证（无应用密码）时整卡禁用并说明；后端依旧独立拒绝。失败时保留表单内容。
 */
export function ConnectorSettings({ authEnabled, projects }: { authEnabled: boolean; projects: Array<{ id: string; label: string }> }) {
  const [revision, setRevision] = useState(0);
  const [items, setItems] = useState<ConnectorDto[]>([]);
  const [draft, setDraft] = useState<{ mode: 'new' | 'edit'; value: Draft } | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testCard, setTestCard] = useState<{ connectorId: string; targetId: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await connectorsApi.listAll();
      setRevision(r.revision);
      setItems(r.items);
    } catch (e) {
      setMessage({ kind: 'error', text: describeConnectorError(e) });
    }
  }, []);
  useEffect(() => { if (authEnabled) void reload(); }, [authEnabled, reload]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const ok = await fn();
      if (ok) setMessage({ kind: 'ok', text: ok });
    } catch (e) {
      setMessage({ kind: 'error', text: describeConnectorError(e) });
      if (e instanceof ConnectorApiError && e.code === 'REVISION_CONFLICT') await reload();
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    if (!draft) return;
    const v = draft.value;
    if (draft.mode === 'new') {
      const r = await connectorsApi.create(revision, v);
      setRevision(r.revision);
    } else {
      const { id, kind: _k, ...patch } = v;
      const r = await connectorsApi.patch(id, revision, patch);
      setRevision(r.revision);
    }
    setDraft(null);
    await reload();
    return '已保存（保存不会发送任何消息）';
  });

  const disabledReason = !authEnabled ? '先在后端设置应用密码并登录，才能配置外部连接器。' : null;

  return (
    <Card data-testid="connector-settings">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><MessageSquare className="size-4 text-muted-foreground" />外部连接器（飞书）</CardTitle>
        <CardDescription className="text-xs">
          把派发结果发到指定的飞书群或私聊。新建默认停用；只会发给这里列出的目标。App Secret 不在网页填写，只填存放它的环境变量名。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-2 text-xs">
        {disabledReason && <p role="note" className="rounded-md bg-muted p-2 text-muted-foreground">{disabledReason}</p>}
        {!draft && <StatusLine message={message} />}
        {authEnabled && items.length === 0 && !draft && <p className="text-muted-foreground">还没有连接器。</p>}
        {items.map((c) => (
          <div key={c.id} className="min-w-0 space-y-1 rounded-lg border border-border/60 p-2" data-testid="connector-row">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-medium">{c.label}</span>
              <Badge variant="outline" data-testid="connector-state">{STATE_TEXT[c.status.state] ?? c.status.state}</Badge>
              {c.status.reason && <span className="break-all text-destructive">{c.status.reason}</span>}
            </div>
            <div className="break-all text-muted-foreground">
              App ID {c.appId} · Secret 环境变量 {c.secretEnv}：{c.secretConfigured ? '已配置' : '未配置'} · {c.targets.length} 个目标
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => setDraft({ mode: 'edit', value: toDraft(c) })}>编辑</Button>
              <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => run(async () => {
                const r = await connectorsApi.patch(c.id, revision, { enabled: !c.enabled });
                setRevision(r.revision); await reload();
                return c.enabled ? '已停用' : '已启用（启用本身不发送消息）';
              })}>{c.enabled ? '停用' : '启用'}</Button>
              <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => run(async () => {
                const r = await connectorsApi.test(c.id);
                return r.ok ? '验证通过（未发送任何消息）' : Promise.reject(new ConnectorApiError(400, r.code ?? 'VERIFY_FAILED', '验证失败'));
              })}>无消息验证</Button>
              <Button className="min-h-11" variant="outline" disabled={busy || !c.enabled || c.targets.length === 0} title={c.enabled ? '向一个目标真实发送一张测试卡，需二次确认' : '启用后才能发送测试卡'}
                onClick={() => setTestCard({ connectorId: c.id, targetId: c.targets[0]?.id ?? '' })}>发送测试卡…</Button>
              <Button className="min-h-11 text-destructive" variant="ghost" disabled={busy} onClick={() => run(async () => {
                if (!window.confirm(`删除连接器「${c.label}」？`)) return;
                await connectorsApi.remove(c.id, revision); await reload();
                return '已删除';
              })}>删除</Button>
            </div>
            {testCard?.connectorId === c.id && (
              <div className="min-w-0 space-y-2 rounded-md border border-destructive/40 p-2" data-testid="test-card-confirm">
                <label className="flex min-w-0 flex-wrap items-center gap-2">发送到
                  <select className="h-11 min-w-0 max-w-full rounded-md border bg-background px-2" aria-label="测试卡目标" value={testCard.targetId}
                    onChange={(e) => setTestCard({ ...testCard, targetId: e.target.value })}>
                    {c.targets.map((t) => <option key={t.id} value={t.id}>{t.label}（{t.kind === 'group' ? '群' : '私聊'} {t.externalId}）</option>)}
                  </select>
                </label>
                <p className="break-all text-destructive">将真实发送一张测试卡到「{c.targets.find((t) => t.id === testCard.targetId)?.label}」，对方会看到这条消息。不含任何照片或任务信息。</p>
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-11" variant="destructive" disabled={busy || !testCard.targetId} onClick={() => run(async () => {
                    const r = await connectorsApi.testCard(c.id, testCard.targetId);
                    setTestCard(null);
                    return r.result.status === 'sent' ? '测试卡已发送' : Promise.reject(new ConnectorApiError(502, r.result.code ?? 'SEND_FAILED', '测试卡发送失败'));
                  })}>确认发送测试卡</Button>
                  <Button className="min-h-11" variant="ghost" disabled={busy} onClick={() => setTestCard(null)}>取消</Button>
                </div>
              </div>
            )}
          </div>
        ))}
        {draft && (
          <form className="min-w-0 space-y-2 rounded-lg border p-2" aria-label="连接器表单" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
              <label className="min-w-0 text-[11px]">名称<Input className="h-11" aria-label="连接器名称" value={draft.value.label} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, label: e.target.value } })} /></label>
              <label className="min-w-0 text-[11px]">App ID（cli_…）<Input className="h-11" aria-label="App ID" value={draft.value.appId} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, appId: e.target.value.trim() } })} /></label>
              <label className="min-w-0 text-[11px]">Secret 环境变量名<Input className="h-11" aria-label="Secret 环境变量名" value={draft.value.secretEnv} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, secretEnv: e.target.value.trim() } })} /></label>
              <label className="min-w-0 text-[11px]">租户 tenant_key（可空）<Input className="h-11" aria-label="租户" value={draft.value.tenantId ?? ''} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, tenantId: e.target.value.trim() || null } })} /></label>
              <label className="min-w-0 text-[11px] sm:col-span-2">可在聊天里创建任务的用户 open_id（逗号分隔，空 = 无人）
                <Input className="h-11" aria-label="创建权限用户" value={draft.value.creatorActorIds.join(', ')} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, creatorActorIds: parseCsv(e.target.value) } })} />
              </label>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[11px]" role="group" aria-label="可创建任务的项目">
              <span className="text-muted-foreground">可创建任务的项目：</span>
              {projects.map((p) => (
                <label key={p.id} className="flex min-h-11 items-center gap-1">
                  <input type="checkbox" className="size-5" checked={draft.value.creatorProjectIds.includes(p.id)} onChange={(e) => setDraft({ ...draft, value: { ...draft.value, creatorProjectIds: e.target.checked ? [...draft.value.creatorProjectIds, p.id] : draft.value.creatorProjectIds.filter((x) => x !== p.id) } })} />
                  {p.label}
                </label>
              ))}
            </div>
            <TargetEditor connectorId={draft.value.id} targets={draft.value.targets} projects={projects} onChange={(targets) => setDraft({ ...draft, value: { ...draft.value, targets } })} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-11" disabled={busy}>保存</Button>
              <Button type="button" variant="ghost" className="min-h-11" onClick={() => setDraft(null)}>取消</Button>
              <StatusLine message={message} />
            </div>
          </form>
        )}
        {authEnabled && !draft && <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => setDraft({ mode: 'new', value: blank(items) })}>新建飞书连接器</Button>}
        {authEnabled && items.length > 0 && !draft && <PolicyEditor connectors={items} projects={projects} />}
      </CardContent>
    </Card>
  );
}

/** 保存结果就地显示（打开表单时紧挨着「保存」按钮，不用滚回顶部找） */
function StatusLine({ message }: { message: { kind: 'ok' | 'error'; text: string } | null }) {
  return <div role="status" aria-live="polite" className={`self-center ${message?.kind === 'error' ? 'text-destructive' : 'text-ok'}`}>{message?.text}</div>;
}
