import type { ConnectorTargetDto } from '@/api/contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const csv = (v: string[]) => v.join(', ');
const parseCsv = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

/** 群/私聊目标编辑：外部 id、允许用户、项目、能力。项目留空 = 不授权任何项目（不是“全部”）。 */
export function TargetEditor({
  connectorId, targets, projects, onChange,
}: {
  connectorId: string;
  targets: ConnectorTargetDto[];
  projects: Array<{ id: string; label: string }>;
  onChange: (next: ConnectorTargetDto[]) => void;
}) {
  const set = (i: number, patch: Partial<ConnectorTargetDto>) => onChange(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const add = () => {
    let n = targets.length + 1;
    while (targets.some((t) => t.id === `t${n}`)) n++;
    onChange([...targets, { id: `t${n}`, connectorId, label: '', kind: 'group', externalId: '', projectIds: [], allowedActorIds: [], canAnnotate: false, canRequestJpeg: false }]);
  };
  return (
    <fieldset className="space-y-2" aria-label="接收目标">
      <legend className="text-xs font-medium">接收目标（群或私聊）</legend>
      {targets.length === 0 && <p className="text-[11px] text-muted-foreground">还没有目标：启用后也不会向任何地方发送。</p>}
      {targets.map((t, i) => (
        <div key={i} className="min-w-0 space-y-1.5 rounded-lg border border-border/60 p-2" data-testid="target-row">
          <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
            <label className="min-w-0 text-[11px]">名称
              <Input className="h-11" aria-label="目标名称" value={t.label} onChange={(e) => set(i, { label: e.target.value })} />
            </label>
            <label className="min-w-0 text-[11px]">类型
              <select className="h-11 w-full rounded-md border bg-background px-2 text-sm" aria-label="目标类型" value={t.kind}
                onChange={(e) => set(i, { kind: e.target.value as 'group' | 'user' })}>
                <option value="group">群</option>
                <option value="user">私聊</option>
              </select>
            </label>
            <label className="min-w-0 text-[11px]">{t.kind === 'group' ? '群 chat_id（oc_…）' : '用户 open_id（ou_…）'}
              <Input className="h-11" aria-label="外部 ID" value={t.externalId} onChange={(e) => set(i, { externalId: e.target.value.trim() })} />
            </label>
            <label className="min-w-0 text-[11px]">允许操作的用户 open_id（逗号分隔）
              <Input className="h-11" aria-label="允许用户" value={csv(t.allowedActorIds)} onChange={(e) => set(i, { allowedActorIds: parseCsv(e.target.value) })} />
            </label>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" role="group" aria-label="授权项目">
            <span className="text-muted-foreground">授权项目：</span>
            {projects.map((p) => (
              <label key={p.id} className="flex min-h-11 items-center gap-1">
                <input type="checkbox" className="size-5" checked={t.projectIds.includes(p.id)}
                  onChange={(e) => set(i, { projectIds: e.target.checked ? [...t.projectIds, p.id] : t.projectIds.filter((x) => x !== p.id) })} />
                {p.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 text-[11px]">
            <label className="flex min-h-11 items-center gap-1"><input type="checkbox" className="size-5" checked={t.canAnnotate} onChange={(e) => set(i, { canAnnotate: e.target.checked })} />可在聊天里标注</label>
            <label className="flex min-h-11 items-center gap-1"><input type="checkbox" className="size-5" checked={t.canRequestJpeg} onChange={(e) => set(i, { canRequestJpeg: e.target.checked })} />可索取 JPEG 原图</label>
            <Button type="button" variant="ghost" className="min-h-11 text-destructive" onClick={() => onChange(targets.filter((_, j) => j !== i))}>移除目标</Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" className="min-h-11" onClick={add}>添加目标</Button>
    </fieldset>
  );
}
