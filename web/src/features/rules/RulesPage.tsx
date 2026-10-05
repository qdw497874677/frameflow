import { Info, ListChecks, Plus } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { Rule } from '@/core/types';

/**
 * 规则页：归档规则长什么样、现在启用哪几条。
 * 现在只能开关；可视化编辑（变量、匹配、预览）在 wayfinder 票 003 里定。
 */
export function RulesPage() {
  const { rules, busy } = useAppState();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
        <span>规则决定「什么样的照片、按什么模板、搬到哪个目录」</span>
        <Button size="sm" variant="outline" className="ml-auto" disabled>
          <Plus className="size-4" />
          新建规则
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {rules.map((r) => (
          <RuleCard key={r.id} rule={r} busy={busy} />
        ))}

        <Card className="border-dashed bg-transparent">
          <CardContent className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p>
                模板变量：<code className="text-foreground">{'{root}'}</code> 根目录、
                <code className="text-foreground"> {'{project}'}</code> 项目（根下第一层）、
                <code className="text-foreground"> {'{device}'}</code> 机身、
                <code className="text-foreground"> {'{kind}'}</code> 照片/视频、
                <code className="text-foreground"> {'{variant}'}</code> 原始/修改后、
                <code className="text-foreground"> {'{date}'}</code> 拍摄日。
              </p>
              <p>
                规则存在后端（契约 <code>GET/PUT /rules</code>，实际落地为 YAML）；页面上的编辑 UI
                在 wayfinder 票 003「归档规则 DSL」里定稿后接上。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RuleCard({ rule, busy }: { rule: Rule; busy: boolean }) {
  const m = rule.match;
  const conds = [
    m.kind && m.kind !== 'any' ? (m.kind === 'video' ? '只视频' : '只照片') : '照片和视频',
    m.minStars ? `≥ ${m.minStars} 星` : '不限星级',
    m.del ? '含待删' : '不含待删',
    m.camera ? m.camera : null,
  ].filter(Boolean) as string[];

  return (
    <Card className={rule.enabled ? '' : 'opacity-60'}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ListChecks className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{rule.name}</span>
          <Switch
            checked={rule.enabled}
            disabled={busy}
            onCheckedChange={() => void store.toggleRule(rule.id)}
            className="ml-auto shrink-0"
            aria-label={rule.enabled ? '停用' : '启用'}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-1">
          {conds.map((c) => (
            <Badge key={c} variant="secondary" className="font-normal">
              {c}
            </Badge>
          ))}
          <Badge variant="outline" className="font-normal">
            {rule.pair ? 'RAW+JPEG 成对' : '只动主文件'}
          </Badge>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span className="shrink-0 text-muted-foreground/60">→</span>
          <span className="truncate">{rule.dest}</span>
        </div>
      </CardContent>
    </Card>
  );
}
