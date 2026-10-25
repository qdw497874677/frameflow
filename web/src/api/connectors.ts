import type {
  ConnectorDto, ConnectorInstanceInputDto, ConnectorMutationDto, ConnectorPageDto, ConnectorVerifyResultDto,
} from './contract';

/**
 * 连接器管理客户端（/connectors，仅管理 session）。错误保留后端 code，
 * 让设置页能如实显示 PASSWORD_REQUIRED / REVISION_CONFLICT 等，而不是统一“失败”。
 */
export class ConnectorApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function base(): string | null {
  return (import.meta.env.VITE_API_BASE as string | undefined) ?? null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const b = base();
  if (!b) throw new ConnectorApiError(0, 'MOCK_MODE', '演示数据模式下不能管理连接器');
  const res = await fetch(`${b}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { code?: string; error?: string };
      code = j.code ?? code;
      message = j.error ?? message;
    } catch { /* 非 JSON */ }
    throw new ConnectorApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const connectorsApi = {
  async listAll(): Promise<{ revision: number; items: ConnectorDto[] }> {
    const items: ConnectorDto[] = [];
    let cursor: string | null = null;
    let revision = 0;
    do {
      const q: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const page: ConnectorPageDto = await call<ConnectorPageDto>('GET', `/connectors${q}`);
      items.push(...page.items);
      revision = page.revision;
      cursor = page.nextCursor;
    } while (cursor);
    return { revision, items };
  },
  create: (expectedRevision: number, instance: ConnectorInstanceInputDto) =>
    call<ConnectorMutationDto>('POST', '/connectors', { expectedRevision, instance }),
  patch: (id: string, expectedRevision: number, patch: Partial<Omit<ConnectorInstanceInputDto, 'enabled' | 'id' | 'kind'>> & { enabled?: boolean }) =>
    call<ConnectorMutationDto>('PATCH', `/connectors/${encodeURIComponent(id)}`, { expectedRevision, patch }),
  remove: (id: string, expectedRevision: number) =>
    call<{ revision: number }>('DELETE', `/connectors/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`),
  test: (id: string) => call<ConnectorVerifyResultDto>('POST', `/connectors/${encodeURIComponent(id)}/test`),
};

/** 常见错误码 → 中文说明（未知码原样显示，不吞） */
export function describeConnectorError(e: unknown): string {
  if (!(e instanceof ConnectorApiError)) return e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    PASSWORD_REQUIRED: '先在后端设置应用密码，才能管理连接器',
    SESSION_REQUIRED: '只能在已登录的浏览器设置页管理连接器',
    CSRF_REJECTED: '跨站请求被拒绝，请从本应用页面操作',
    REVISION_CONFLICT: '配置已被别处修改，已刷新，请重试',
    CONNECTOR_ENABLED: '请先停用再删除',
    CONNECTOR_REFERENCED: '仍被投递策略引用，先修改策略再删除',
    MOCK_MODE: '演示数据模式下不能管理连接器',
  };
  return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
}
