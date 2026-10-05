import { Info, ListChecks, Plus } from 'lucide-react';
import { store, useAppState } from '@/core/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { Rule } from '@/core/types';

/**
 * 规则页：归档规则长什么样、现在启用哪几条。
 * 现在只能开关；可视化编辑器（排序、命中预演、别名表）在 wayfinder 票 007 里定。
 * 规则语义的权威定义在 contracts/rules.md（票 003 的产出）。
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
                <code className="text-foreground"> {'{date:FORMAT}'}</code> 拍摄日（如 {'{date:YYYY-MM}'}）、
                <code className="text-foreground"> {'{folder:N}'}</code> 当前目录的第 N 层目录名。
              </p>
              <p>
                顺序即语义：<span className="text-foreground">首条命中的规则定去向</span>
                ，待删的照片不参与归档；目标已有同名文件时追加序号，绝不覆盖。规范见 AGENTS 根目录的
                <code className="text-foreground"> contracts/rules.md</code>，编辑器见 wayfinder 票 007。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** 把匹配条件翻成人话（不同条件 AND、同字段数组 OR） */
function condLabels(rule: Rule): string[] {
  const m = rule.match;
  const out: string[] = [];

  const kinds = (Array.isArray(m.kind) ? m.kind : m.kind ? [m.kind] : []).filter((k) => k !== 'any');
  out.push(kinds.length ? kinds.map((k) => (k === 'video' ? '视频' : '照片')).join(' / ') : '照片和视频');

  if (typeof m.stars === 'number') out.push(`≥ ${m.stars} 星`);
  else if (m.stars) out.push(starsLabel(m.stars));

  if (m.marked !== undefined) out.push(m.marked ? '打过星' : '没打星');

  for (const v of [m.camera, m.lens]) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push(one.startsWith('=') ? `就是 ${one.slice(1)}` : one);
  }

  if (m.taken) {
    const parts: string[] = [];
    if (m.taken.after) parts.push(`≥ ${m.taken.after.slice(0, 10)}`);
    if (m.taken.before) parts.push(`≤ ${m.taken.before.slice(0, 10)}`);
    if (m.taken.lastDays !== undefined) parts.push(`近 ${m.taken.lastDays} 天`);
    if (parts.length) out.push(`拍摄 ${parts.join(' 且 ')}`);
  }

  if (m.folder) out.push(`目录 ${m.folder}`);
  if (rule.onlyFrom?.length) out.push(`只从 ${rule.onlyFrom.join(' / ')}`);
  if (rule.action === 'skip') out.push('跳过不归档');
  return out;
}

function starsLabel(s: { gte?: number; lte?: number; eq?: number }): string {
  if (s.eq !== undefined) return `正好 ${s.eq} 星`;
  const lo = s.gte !== undefined ? `≥ ${s.gte}` : '';
  const hi = s.lte !== undefined ? `≤ ${s.lte}` : '';
  if (lo && hi) return `${lo} 且 ${hi} 星`;
  return `${lo || hi} 星`;
}

function RuleCard({ rule, busy }: { rule: Rule; busy: boolean }) {
  const conds = condLabels(rule);

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
