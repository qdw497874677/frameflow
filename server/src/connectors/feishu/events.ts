/**
 * 可信事件映射（F19）：把 SDK 合并 header+event 后的数据严格映射成平台无关 ConnectorEvent。
 * 只信 SDK envelope 中的 app_id / tenant_key / operator / context；缺任何一项即拒绝。
 * action.value 只取不透明的 sessionId/actionId 字符串；form_value 只保留标量字段。
 */
import type { ConnectorEvent, ConnectorInstanceConfig } from '../types.ts';

export type MapResult = { ok: true; event: ConnectorEvent } | { ok: false; code: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function scalars(v: unknown, max = 32): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  const o = obj(v);
  if (!o) return out;
  for (const [k, x] of Object.entries(o).slice(0, max)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) continue;
    if (typeof x === 'string') out[k] = x.slice(0, 2000);
    else if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
    else if (Array.isArray(x) && x.every((y) => typeof y === 'string')) out[k] = x.slice(0, 32).map((y) => (y as string).slice(0, 200));
  }
  return out;
}

function envelope(d: Record<string, unknown>, inst: ConnectorInstanceConfig): string | null {
  if (str(d['app_id']) !== inst.appId) return 'APP_MISMATCH';
  if (!inst.tenantId) return 'TENANT_UNBOUND';
  if (str(d['tenant_key']) !== inst.tenantId) return 'TENANT_MISMATCH';
  return null;
}

/** card.action.trigger（新版卡片回调） */
export function mapCardAction(d: Record<string, unknown>, inst: ConnectorInstanceConfig): MapResult {
  const bad = envelope(d, inst);
  if (bad) return { ok: false, code: bad };
  const operator = obj(d['operator']);
  const actorId = str(operator?.['open_id']);
  if (!actorId) return { ok: false, code: 'ACTOR_MISSING' };
  if (operator?.['tenant_key'] !== undefined && operator['tenant_key'] !== inst.tenantId) return { ok: false, code: 'TENANT_MISMATCH' };
  const ctx = obj(d['context']);
  const chatId = str(ctx?.['open_chat_id']);
  const messageId = str(ctx?.['open_message_id']) ?? undefined;
  const action = obj(d['action']);
  const value = obj(action?.['value']);
  if (!value) return { ok: false, code: 'ACTION_VALUE_MISSING' };
  // 会话判定：配置里的群目标优先；否则视为与操作者本人的私聊（仅当存在该用户目标）
  let source: ConnectorEvent['source'] = null;
  if (chatId && inst.targets.some((t) => t.kind === 'group' && t.externalId === chatId)) source = { kind: 'group', externalId: chatId };
  else if (chatId && inst.targets.some((t) => t.kind === 'user' && t.externalId === actorId)) source = { kind: 'user', externalId: actorId };
  else if (chatId) source = { kind: 'group', externalId: chatId }; // 未配置会话：交给授权拒绝
  const payload: Record<string, unknown> = { type: 'card-action' };
  for (const k of ['sessionId', 'actionId', 'op']) { const s = str(value[k]); if (s) payload[k] = s; }
  payload['form'] = scalars(action?.['form_value']);
  const eventId = str(d['event_id']) ?? undefined;
  return { ok: true, event: { identity: { connectorId: inst.id, tenantId: inst.tenantId!, actorId }, source, messageId, eventId, payload } };
}

/** im.message.receive_v1（文字命令） */
export function mapMessage(d: Record<string, unknown>, inst: ConnectorInstanceConfig): MapResult {
  const bad = envelope(d, inst);
  if (bad) return { ok: false, code: bad };
  const sender = obj(d['sender']);
  const actorId = str(obj(sender?.['sender_id'])?.['open_id']);
  if (!actorId) return { ok: false, code: 'ACTOR_MISSING' };
  if (sender?.['sender_type'] !== undefined && sender['sender_type'] !== 'user') return { ok: false, code: 'NOT_A_USER' };
  const msg = obj(d['message']);
  const chatId = str(msg?.['chat_id']);
  const chatType = msg?.['chat_type'];
  if (!chatId || (chatType !== 'p2p' && chatType !== 'group')) return { ok: false, code: 'CONTEXT_MISSING' };
  const source = chatType === 'group' ? { kind: 'group' as const, externalId: chatId } : { kind: 'user' as const, externalId: actorId };
  let text = '';
  if (msg?.['message_type'] === 'text') {
    try { const c = JSON.parse(String(msg['content'] ?? '{}')) as { text?: unknown }; text = typeof c.text === 'string' ? c.text.slice(0, 500) : ''; } catch { return { ok: false, code: 'CONTENT_INVALID' }; }
  }
  return {
    ok: true,
    event: { identity: { connectorId: inst.id, tenantId: inst.tenantId!, actorId }, source, messageId: str(msg?.['message_id']) ?? undefined, eventId: str(d['event_id']) ?? undefined, payload: { type: 'message', text: text.replace(/@_user_\d+/g, '').trim(), mentioned: Array.isArray(msg?.['mentions']) && (msg['mentions'] as unknown[]).length > 0 } },
  };
}
