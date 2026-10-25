/**
 * 卡片渲染（F20）：语义内容 → 飞书新版卡片（schema 2.0）JSON。按钮只携带不透明 sessionId/actionId，
 * 不放照片 ID、token 或链接凭据。卡片更新有效期受限：超过窗口只能由用户显式操作重开新卡。
 */

/** 飞书消息更新窗口（保守取 14 天） */
export const CARD_UPDATE_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface CardAction { readonly label: string; readonly actionId: string; readonly primary?: boolean }

export interface CardModel {
  readonly title: string;
  readonly lines: readonly string[];
  readonly photoId?: string;
  readonly sessionId?: string;
  readonly actions?: readonly CardAction[];
  /** 逐张确认表单：星级与待删 */
  readonly reviewForm?: { readonly stars: number | null; readonly reject: boolean };
}

export function updateAllowed(sentAt: number, now = Date.now()): boolean {
  return now - sentAt < CARD_UPDATE_WINDOW_MS;
}

const md = (content: string) => ({ tag: 'markdown', content });
const esc = (s: string) => s.replace(/[<>*_`~\[\]]/g, (c) => `\\${c}`);

export function renderCard(m: CardModel, imageKey?: string): string {
  const elements: unknown[] = [];
  if (imageKey) elements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: m.title.slice(0, 50) }, preview: true });
  for (const l of m.lines) elements.push(md(esc(l)));
  const value = (actionId: string) => ({ sessionId: m.sessionId ?? '', actionId });
  if (m.reviewForm) {
    elements.push({
      tag: 'form', name: 'review', elements: [
        { tag: 'select_static', name: 'stars', placeholder: { tag: 'plain_text', content: '星级' }, initial_option: m.reviewForm.stars === null ? undefined : String(m.reviewForm.stars),
          options: ['0', '1', '2', '3', '4', '5'].map((v) => ({ text: { tag: 'plain_text', content: v === '0' ? '无星' : `${v} 星` }, value: v })) },
        { tag: 'checker', name: 'reject', checked: m.reviewForm.reject, text: { tag: 'plain_text', content: '待删' } },
        { tag: 'button', name: 'submit', form_action_type: 'submit', type: 'primary', text: { tag: 'plain_text', content: '确认并下一张' }, behaviors: [{ type: 'callback', value: value('submit') }] },
      ],
    });
  }
  for (const a of m.actions ?? []) {
    elements.push({ tag: 'button', type: a.primary ? 'primary' : 'default', text: { tag: 'plain_text', content: a.label }, behaviors: [{ type: 'callback', value: value(a.actionId) }] });
  }
  return JSON.stringify({ schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: m.title.slice(0, 100) } }, body: { elements } });
}
