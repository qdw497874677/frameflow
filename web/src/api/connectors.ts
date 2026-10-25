import type {
  DeliveryAppendDto,
  DeliveryAppendPreviewDto,
  ConnectorDto, ConnectorInstanceInputDto, ConnectorMutationDto, ConnectorPageDto, ConnectorVerifyResultDto,
  DeliveryConfirmationDto, DeliveryPartPageDto, DeliveryPolicyInputDto, DeliveryPolicyMutationDto, DeliveryPolicyPageDto,
  DeliveryPreviewDto, DeliveryTargetRefDto,
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
  if (res.status === 204) return undefined as T;
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
  /** 显式测试卡（F21）：会真实发送一条消息，调用方须先让用户确认 */
  testCard: (id: string, targetId: string) =>
    call<{ targetId: string; result: { status: string; code?: string } }>('POST', `/connectors/${encodeURIComponent(id)}/test-card`, { targetId, confirm: true }),
};

/** 投递策略 / 预览 / 确认 / 外传状态（F12/F16） */
export const deliveryApi = {
  policies: () => call<DeliveryPolicyPageDto>('GET', '/delivery-policies?limit=100'),
  createPolicy: (expectedRevision: number, policy: DeliveryPolicyInputDto) =>
    call<DeliveryPolicyMutationDto>('POST', '/delivery-policies', { expectedRevision, policy }),
  patchPolicy: (id: string, expectedRevision: number, patch: Partial<Omit<DeliveryPolicyInputDto, 'id'>>) =>
    call<DeliveryPolicyMutationDto>('PATCH', `/delivery-policies/${encodeURIComponent(id)}`, { expectedRevision, patch }),
  removePolicy: (id: string, expectedRevision: number) =>
    call<DeliveryPolicyMutationDto>('DELETE', `/delivery-policies/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`),
  preview: (body: { projectId: string; selection: unknown; params?: { alias?: string | null; note?: string | null; notifyOnComplete?: boolean }; targets?: DeliveryTargetRefDto[] }) =>
    call<DeliveryPreviewDto>('POST', '/delivery-previews', body),
  cancelPreview: (id: string) => call<void>('DELETE', `/delivery-previews/${encodeURIComponent(id)}`),
  confirm: (body: { previewId: string; revision: string; requestId: string; notifyOnComplete: boolean; acknowledged: boolean }) =>
    call<DeliveryConfirmationDto>('POST', '/delivery-confirmations', body),
  deliveries: (jobId: string) => call<DeliveryPartPageDto>('GET', `/jobs/${encodeURIComponent(jobId)}/deliveries`),
  /** F30：显式测试卡——调用方必须先完成二次确认（UI 展示目标）；confirm 字段只是后端的第二道闸 */
  /** F29a：追加目标——预览（零发送）与确认（requestId 稳定，重放仍关联原任务） */
  appendPreview: (jobId: string, targets: DeliveryTargetRefDto[]) =>
    call<DeliveryAppendPreviewDto>('POST', `/jobs/${encodeURIComponent(jobId)}/delivery-previews`, { targets }),
  appendConfirm: (jobId: string, body: { previewId: string; revision: string; requestId: string; notifyOnComplete: boolean; acknowledged: boolean }) =>
    call<DeliveryAppendDto>('POST', `/jobs/${encodeURIComponent(jobId)}/delivery-appends`, body),
  retry: (jobId: string, t: DeliveryTargetRefDto, acceptDuplicateRisk = false) =>
    call<DeliveryPartPageDto>('POST', `/jobs/${encodeURIComponent(jobId)}/deliveries/retry`, { ...t, acceptDuplicateRisk }),
};

/** 确认重试复用的稳定 requestId */
export function newRequestId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return `req_${[...a].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

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
    PREVIEW_EXPIRED: '预览已过期，请重新预览',
    PREVIEW_STALE: '照片、目标或策略已变化，请重新预览',
    PREVIEW_REVISION_MISMATCH: '预览已变化，请重新预览',
    PREVIEW_NOT_FOUND: '预览不存在，请重新预览',
    TARGET_NOT_ALLOWED: '所选目标不可用或未授权该项目',
    DUPLICATE_RISK: '有状态未知的消息：重试可能重复外传，需确认风险',
    ATTEMPT_IN_FLIGHT: '上一次尝试还没结束，稍后再试',
    NOTHING_TO_RETRY: '没有需要重试的消息',
    TARGET_ALREADY_IN_JOB: '目标已在任务中；失败请用重试，不会重复追加',
    PREVIEW_JOB_MISMATCH: '预览不属于该任务，请重新预览',
    JOB_CLOSED: '任务已取消或失败，不能追加目标',
    JOB_NOT_FOUND: '任务不存在或不是外传任务',
    REQUEST_ID_CONFLICT: '确认内容与上次不一致，请重新预览',
  };
  return map[e.code] ? `${map[e.code]}（${e.code}）` : `${e.message}（${e.code}）`;
}
