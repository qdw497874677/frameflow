/** 把后端回的配置字段路径（如 `instance.targets[0].projectIds[1]`）翻成用户看得懂的位置。 */

const NAMES: Record<string, string> = {
  id: 'ID', label: '名称', appId: 'App ID', secretEnv: '密钥环境变量', tenantId: '租户',
  targets: '目标', externalId: '群/用户 ID', projectIds: '授权项目', allowedActorIds: '允许的用户',
  creatorActorIds: '创建权限用户', creatorProjectIds: '可创建任务的项目', event: '事件', enabled: '启用',
};

export function fieldLabel(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split('.').slice(1); // 去掉 instance / policy 前缀
  if (parts.length === 0) return null;
  return parts
    .map((p) => {
      const m = /^(\w+)((?:\[\d+\])*)$/.exec(p);
      if (!m) return p;
      const idx = [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => ` 第 ${Number(x[1]) + 1} 项`).join('');
      return `${NAMES[m[1]] ?? m[1]}${idx}`;
    })
    .join(' › ');
}
