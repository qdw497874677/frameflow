/**
 * 飞书传输端口（F19/F20）：实现平台无关的 ManagedConnectorPort。
 *
 * - 出站（HTTP API）与长连接（WS）状态分开记录（health()）。
 * - 发送有界等待：超时返回 unknown，原 SDK 调用继续，迟到成功经 onLate 归回原 intentId；绝不替代重发。
 * - uuid=intentId，交给平台按意图去重。
 * - 频控/业务错误码 → failed（频控可重试）；传输层异常 → unknown（无法确认是否已送达）。
 * - 回调受理有界：处理超过 ackBudgetMs 先回「已受理」，业务继续在后台完成，保证 3 秒内应答。
 */
import type {
  ConnectorEvent, ConnectorInstanceConfig, DeliveryResult, EventAck, ManagedConnectorPort, SemanticContent, SendInput, UpdateInput, VerifyResult,
} from '../../domain/connectors/types.ts';
import type { FeishuApi, FeishuLongConnection, FeishuSdk, ImResponse } from './client.ts';
import { renderCard, type CardModel } from './cards.ts';
import { mapCardAction, mapMessage } from './events.ts';
import { MediaError, MediaUploader, readJpeg, type OriginalJpegProvider, type PreviewProvider } from './media.ts';

/** 飞书频控错误码 */
export const RATE_LIMIT_CODES = new Set([99991400, 230020, 11232]);
/** image_key 失效/不存在（需重传） */
export const IMAGE_INVALID_CODES = new Set([230055, 234001, 234006]);

export type CardResolver = (content: SemanticContent, sessionId?: string) => Promise<CardModel | null>;

export const defaultResolver: CardResolver = async (c, sessionId) => {
  if (c.type === 'test-card') return { title: 'FrameFlow 测试卡', lines: ['这是管理员手动发送的连接测试卡片，可以忽略。'] };
  if (c.type === 'task-entry') return { title: 'FrameFlow 批注任务', lines: ['有一批照片等待批注。'], sessionId, actions: [{ label: '开始批注', actionId: 'open', primary: true }] };
  return null;
};

export interface Health {
  readonly outbound: 'unknown' | 'ok' | 'error';
  readonly outboundCode?: string;
  readonly longConnection: 'stopped' | 'starting' | 'started' | 'error';
}

export interface FeishuTransportOptions {
  readonly instance: ConnectorInstanceConfig;
  readonly secret: string;
  readonly sdk: FeishuSdk;
  readonly resolve?: CardResolver;
  readonly preview?: PreviewProvider;
  /** F28：原图 JPEG 来源（只在显式请求时读取） */
  readonly original?: OriginalJpegProvider;
  readonly timeoutMs?: number;
  readonly ackBudgetMs?: number;
  /** 超时后原调用迟到成功/失败的回报（按原 intentId） */
  readonly onLate?: (intentId: string, result: DeliveryResult) => void;
}

const isOk = (r: ImResponse) => r.code === 0 || r.code === undefined;

export class FeishuTransport implements ManagedConnectorPort {
  readonly #o: FeishuTransportOptions;
  readonly #api: FeishuApi;
  readonly #media: MediaUploader | null;
  #ws: FeishuLongConnection | null = null;
  #health: Health = { outbound: 'unknown', longConnection: 'stopped' };
  /** 后台继续的回调处理（测试/关停等待） */
  readonly background = new Set<Promise<unknown>>();

  constructor(o: FeishuTransportOptions) {
    this.#o = o;
    this.#api = o.sdk.api(o.instance.appId, o.secret);
    this.#media = o.preview ? new MediaUploader({ api: this.#api, appId: o.instance.appId, preview: o.preview }) : null;
  }

  health(): Health { return this.#health; }

  async verify(): Promise<VerifyResult> {
    try {
      const r = await this.#bounded(this.#api.verifyToken());
      if (r === 'timeout') return { ok: false, code: 'VERIFY_TIMEOUT' };
      if (!isOk(r)) { this.#health = { ...this.#health, outbound: 'error', outboundCode: `FEISHU_${r.code}` }; return { ok: false, code: `FEISHU_${r.code}` }; }
      this.#health = { ...this.#health, outbound: 'ok', outboundCode: undefined };
      return { ok: true };
    } catch { return { ok: false, code: 'VERIFY_FAILED' }; }
  }

  async start(onEvent: (e: ConnectorEvent) => Promise<EventAck>): Promise<void> {
    this.#health = { ...this.#health, longConnection: 'starting' };
    const ws = this.#o.sdk.longConnection(this.#o.instance.appId, this.#o.secret);
    const handle = (map: typeof mapCardAction, card: boolean) => async (raw: Record<string, unknown>) => {
      const m = map(raw ?? {}, this.#o.instance);
      const ack: EventAck = m.ok ? await this.#boundedAck(onEvent(m.event)) : { kind: 'rejected', code: m.code };
      return card ? toCallbackResponse(ack) : undefined;
    };
    try {
      await ws.start({ cardAction: handle(mapCardAction, true), message: handle(mapMessage, false) });
      this.#ws = ws;
      this.#health = { ...this.#health, longConnection: 'started' };
    } catch (e) {
      this.#health = { ...this.#health, longConnection: 'error' };
      ws.close();
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.#ws?.close();
    this.#ws = null;
    this.#health = { ...this.#health, longConnection: 'stopped' };
  }

  async #boundedAck(p: Promise<EventAck>): Promise<EventAck> {
    const budget = this.#o.ackBudgetMs ?? 2500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guarded = p.catch((): EventAck => ({ kind: 'rejected', code: 'HANDLER_FAILED' }));
    const t = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), budget); });
    const r = await Promise.race([guarded, t]);
    clearTimeout(timer);
    if (r !== 'timeout') return r;
    this.background.add(guarded);
    void guarded.finally(() => this.background.delete(guarded));
    return { kind: 'accepted', toast: '已收到，正在处理' };
  }

  #bounded<T>(p: Promise<T>): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.#o.timeoutMs ?? 10_000); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  #target(targetId: string) { return this.#o.instance.targets.find((t) => t.id === targetId); }

  async #content(input: SendInput): Promise<{ content: string } | DeliveryResult> {
    const model = await (this.#o.resolve ?? defaultResolver)(input.content, input.sessionId);
    if (!model) return { status: 'failed', code: 'CONTENT_UNSUPPORTED', retryable: false };
    let imageKey: string | undefined;
    if (model.photoId) {
      if (!this.#media) return { status: 'failed', code: 'PREVIEW_UNAVAILABLE', retryable: false };
      try { imageKey = await this.#media.imageKey(model.photoId); } catch (e) {
        return { status: 'failed', code: e instanceof MediaError ? e.code : 'PREVIEW_UNAVAILABLE', retryable: false };
      }
    }
    return { content: renderCard(model, imageKey), ...(imageKey ? { imageKey, photoId: model.photoId, model } : {}) } as { content: string };
  }

  #classify(r: ImResponse): DeliveryResult | null {
    if (isOk(r)) return null;
    const code = Number(r.code);
    if (RATE_LIMIT_CODES.has(code)) return { status: 'failed', code: 'RATE_LIMITED', retryable: true };
    return { status: 'failed', code: `FEISHU_${code}`, retryable: false };
  }

  async #call(intentId: string, run: () => Promise<ImResponse<{ message_id?: string }>>, messageId?: string): Promise<DeliveryResult> {
    const finish = (r: ImResponse<{ message_id?: string }>): DeliveryResult => {
      const bad = this.#classify(r);
      if (bad) return bad;
      const id = r.data?.message_id ?? messageId;
      return id ? { status: 'sent', messageId: id } : { status: 'unknown', code: 'NO_MESSAGE_ID' };
    };
    const p = run();
    try {
      const r = await this.#bounded(p);
      if (r === 'timeout') {
        void p.then((x) => this.#o.onLate?.(intentId, finish(x)), () => undefined);
        return { status: 'unknown', code: 'TIMEOUT' };
      }
      const out = finish(r);
      this.#health = { ...this.#health, outbound: out.status === 'sent' ? 'ok' : this.#health.outbound };
      return out;
    } catch {
      // 传输异常（重置/中断）：请求可能已被平台接受
      return { status: 'unknown', code: 'TRANSPORT_ERROR' };
    }
  }

  /** F28：原图 JPEG 文件消息（每次都重新读取并上传；不缓存 file_key，避免以缓存替代重新授权） */
  async #sendFile(input: SendInput, t: { kind: string; externalId: string }, photoId: string): Promise<DeliveryResult> {
    if (!this.#o.original) return { status: 'failed', code: 'JPEG_UNAVAILABLE', retryable: false };
    let bytes: Buffer, fileName: string;
    try {
      const src = await this.#o.original(photoId);
      fileName = src.fileName;
      bytes = await readJpeg(src.path, src.fileName);
    } catch (e) { return { status: 'failed', code: e instanceof MediaError ? e.code : 'JPEG_UNAVAILABLE', retryable: false }; }
    let fileKey: string | undefined;
    try {
      const up = await this.#api.uploadFile({ bytes, fileName });
      fileKey = isOk(up) ? up.data?.file_key : undefined;
    } catch { /* 上传失败：未发消息，可安全重试 */ }
    if (!fileKey) return { status: 'failed', code: 'UPLOAD_FAILED', retryable: true };
    const req = { receiveIdType: t.kind === 'group' ? 'chat_id' as const : 'open_id' as const, receiveId: t.externalId, msgType: 'file' as const, content: JSON.stringify({ file_key: fileKey }), uuid: input.intentId.slice(0, 50) };
    return this.#call(input.intentId, () => this.#api.createMessage(req));
  }

  async send(input: SendInput): Promise<DeliveryResult> {
    const t = this.#target(input.targetId);
    if (!t) return { status: 'failed', code: 'TARGET_REVOKED', retryable: false };
    if (input.content.type === 'file') return this.#sendFile(input, t, input.content.mediaRef);
    const c = await this.#content(input);
    if ('status' in c) return c;
    const req = { receiveIdType: t.kind === 'group' ? 'chat_id' as const : 'open_id' as const, receiveId: t.externalId, msgType: 'interactive' as const, content: c.content, uuid: input.intentId.slice(0, 50) };
    let r = await this.#call(input.intentId, () => this.#api.createMessage(req));
    // image_key 失效：重传一次（平台已拒绝，未送达，重发安全）
    const ext = c as { content: string; imageKey?: string; photoId?: string; model?: CardModel };
    if (r.status === 'failed' && ext.imageKey && ext.photoId && ext.model && IMAGE_INVALID_CODES.has(Number(r.code.replace('FEISHU_', '')))) {
      this.#media!.invalidate(ext.imageKey);
      let key: string;
      try { key = await this.#media!.imageKey(ext.photoId, true); } catch (e) { return { status: 'failed', code: e instanceof MediaError ? e.code : 'PREVIEW_UNAVAILABLE', retryable: false }; }
      r = await this.#call(input.intentId, () => this.#api.createMessage({ ...req, content: renderCard(ext.model!, key), uuid: `${req.uuid.slice(0, 46)}-r1` }));
    }
    return r;
  }

  /** 更新卡片：失败只返回结果，调用方不得因此撤销已写入的标记 */
  async update(input: UpdateInput): Promise<DeliveryResult> {
    if (!this.#target(input.targetId)) return { status: 'failed', code: 'TARGET_REVOKED', retryable: false };
    const c = await this.#content(input);
    if ('status' in c) return c;
    return this.#call(input.intentId, () => this.#api.patchMessage({ messageId: input.messageId, content: c.content }), input.messageId);
  }
}

function toCallbackResponse(a: EventAck): unknown {
  if (a.kind === 'accepted') return { toast: { type: 'success', content: a.toast ?? '已受理' } };
  return { toast: { type: 'error', content: a.toast ?? `未受理：${a.code}` } };
}

/** ConnectorFactory：Secret 只在此私有传入 */
export function feishuFactory(deps: { sdk: () => FeishuSdk; resolve?: CardResolver; preview?: PreviewProvider; original?: OriginalJpegProvider; timeoutMs?: number; onLate?: FeishuTransportOptions['onLate'] }) {
  return (instance: ConnectorInstanceConfig, secret: string) => new FeishuTransport({ instance, secret, sdk: deps.sdk(), resolve: deps.resolve, preview: deps.preview, original: deps.original, timeoutMs: deps.timeoutMs, onLate: deps.onLate });
}
