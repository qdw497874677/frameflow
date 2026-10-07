import { Check, Cloud, HardDrive, ListChecks, Server, TriangleAlert } from 'lucide-react';
import { source } from '@/api';
import { store, useAppState } from '@/core/store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/**
 * 设置：根目录、数据源、后端状态。
 * 这一页有意保持「薄」—— 真正要改的东西（后端地址、密码、缓存上限）多数在后端配置里，
 * 前端只显示现状 + 能做的动作。
 */
export function SettingsPage() {
  const { roots, dir, history, busy, authEnabled } = useAppState();

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <HardDrive className="size-4 text-muted-foreground" />
            根目录
          </CardTitle>
          <CardDescription className="text-xs">
            文件夹就是真相：这些是磁盘上被管理的入口，不做导入、不改目录结构 —— 应用只写标记。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {roots.length === 0 && <div className="text-muted-foreground">还没读到根目录。</div>}
          {roots.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5">
              <span className={r.online ? 'text-ok' : 'text-muted-foreground/50'}>
                {r.online ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
              </span>
              <span className="font-mono">{r.path}</span>
              <span className="truncate text-muted-foreground">{r.label}</span>
              {typeof r.photoCount === 'number' && (
                <Badge variant="secondary" className="ml-auto shrink-0 tabular-nums">
                  {r.photoCount}
                </Badge>
              )}
              {!r.online && (
                <>
                  {r.lastError && (
                    <span className="truncate text-muted-foreground/70" title={r.lastError}>
                      {r.lastError}
                    </span>
                  )}
                  <Badge variant="outline" className="ml-auto shrink-0">
                    未连接
                  </Badge>
                </>
              )}
            </div>
          ))}
          <div className="pt-1 text-[11px] text-muted-foreground/70">
            当前目录：<span className="font-mono">{dir}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="size-4 text-muted-foreground" />
            数据源
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant={source.kind === 'http' ? 'default' : 'secondary'}>
              {source.kind === 'http' ? '真实后端' : 'Mock 数据'}
            </Badge>
            <span className="text-muted-foreground">
              {source.kind === 'http'
                ? '通过 contracts/openapi.yaml 的 HTTP 接口访问磁盘'
                : '浏览器内假照片：交互与手势能开发到位，接后端时设 VITE_API_BASE=/api/v1 即可切换'}
            </span>
          </div>
          <Separator />
          <div className="space-y-1 text-muted-foreground">
            <p>后端模块（server/）：scan 扫描配对 · preview 预览分层 · marks 星级写 XMP · trash 回收站 · auth 鉴权 · httpapi 接口层。</p>
            <p>不变式：磁盘是真相 · RAW+JPEG 成对原子 · 缓存可重建；应用只写星标（XMP）与回收站记录，不动原片。</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListChecks className="size-4 text-muted-foreground" />
            标注变更
          </CardTitle>
          <CardDescription className="text-xs">
            每次改动都记下「谁、什么时候、把哪个字段从什么改成了什么」。挑片是同步的，这不会影响手感；
            它是后续把批注任务推给飞书等渠道、再把别人的批注并回来时的对账凭据（契约：GET /marks/history）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {history.length === 0 && (
            <div className="text-muted-foreground">{busy ? '读取中…' : '还没有变更记录。'}</div>
          )}
          {history.slice(0, 10).map((c, i) => (
            <div key={`${c.photoId}-${c.field}-${c.at}-${i}`} className="flex items-center gap-2">
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{c.at.slice(11, 19)}</span>
              <span className="truncate font-mono">{c.displayName ?? c.photoId}</span>
              <span className="shrink-0 text-muted-foreground">{c.field === 'stars' ? '星' : '待删'}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {c.field === 'stars' ? c.from : c.from ? '是' : '否'} →{' '}
                {c.field === 'stars' ? c.to : c.to ? '是' : '否'}
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground/70">
                {c.by} · {c.channel}
              </span>
            </div>
          ))}
          {history.length > 10 && (
            <div className="pt-1 text-[11px] text-muted-foreground/70">只显示最近 10 条（共 {history.length} 条）。</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cloud className="size-4 text-muted-foreground" />
            访问与部署
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>目标形态：家里跑一份，Tailscale 内网随时打开（手机、平板、笔电都能挑片）。</p>
          <p>前端是纯客户端，不碰磁盘；只有后端进程读写文件。</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => void store.loadRoots()}>
              重新读取根目录
            </Button>
            <Button size="sm" variant="outline" onClick={() => void store.loadTrash()}>
              刷新回收站
            </Button>
            <Button size="sm" variant="outline" onClick={() => void store.loadMarkHistory()}>
              刷新标注变更
            </Button>
          </div>
        </CardContent>
      </Card>

      {authEnabled && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Server className="size-4 text-muted-foreground" />
              会话
            </CardTitle>
            <CardDescription className="text-xs">
              密码在后端配置里；退出后回到登录页（换设备时先退一次）。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" variant="outline" onClick={() => void store.logout()}>
              退出登录
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
