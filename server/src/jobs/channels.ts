/**
 * 出站投递通道注册表：任务把一批照片「发出去」的出口。
 *
 * v1 只有内置的应用内通道（`inapp`）：它不发消息，只签发一条批次链接（URL 在任务的 artifacts 里），
 * 批注页以后再做。飞书 / webhook 等外部通道同样是这里的一行 —— 它们都需要凭据，
 * 凭据没配就不注册（`GET /channels` 就看不到）。
 *
 * 注意：**回流不走通道**。外部批注一律 `POST /jobs/{id}/inbound`（见 api/server.ts 与 jobs/annotate.ts），
 * 通道只管「怎么把活派出去」，不管「结果怎么回来」—— 少一条回调路径就少一处签名/重放问题。
 */

export interface Channel {
  id: string;
  kind: string;
  label: string;
  enabled: boolean;
}

const builtin: Channel[] = [
  { id: 'inapp', kind: 'inapp', label: '应用内（批次链接）', enabled: true },
];

export function listChannels(): Channel[] {
  return builtin.map((c) => ({ ...c }));
}

export function channelById(id: string): Channel | undefined {
  return builtin.find((c) => c.id === id);
}

/** 参数校验出错时列给用户看的可用通道 */
export function channelIds(): string[] {
  return builtin.map((c) => c.id);
}
