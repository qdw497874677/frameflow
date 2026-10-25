/**
 * 飞书 SDK 边界（F19）。只有本目录可以接触 SDK；对外暴露的是最小的结构化端口，
 * 测试注入假 SDK，绝不启动真实 WS。
 *
 * - 每个实例一个国内（Domain.Feishu）Client + 一个 WSClient；重连交给 SDK。
 * - SDK 自带 logger 替换为净化 logger：只输出级别和固定短语，不输出参数（可能含 token/事件）。
 * - SDK 生成的 IM 方法不转发单次 timeout/signal；有界等待由 transport 负责，并保留迟到结果。
 */

export interface ImResponse<T = Record<string, unknown>> { code?: number; msg?: string; data?: T }

/** 低层 IM/认证方法的最小形状（与 @larksuiteoapi/node-sdk 1.76.0 的生成方法一致） */
export interface FeishuApi {
  createMessage(req: { receiveIdType: 'chat_id' | 'open_id'; receiveId: string; msgType: 'interactive' | 'image' | 'file' | 'text'; content: string; uuid: string }): Promise<ImResponse<{ message_id?: string }>>;
  patchMessage(req: { messageId: string; content: string }): Promise<ImResponse>;
  uploadImage(bytes: Buffer): Promise<ImResponse<{ image_key?: string }>>;
  uploadFile(req: { bytes: Buffer; fileName: string }): Promise<ImResponse<{ file_key?: string }>>;
  /** 无消息连接验证：取 tenant_access_token */
  verifyToken(): Promise<ImResponse>;
}

export type RawHandler = (data: Record<string, unknown>) => Promise<unknown>;

export interface FeishuLongConnection {
  start(handlers: { cardAction: RawHandler; message: RawHandler }): Promise<void>;
  close(): void;
}

export interface FeishuSdk {
  api(appId: string, appSecret: string): FeishuApi;
  longConnection(appId: string, appSecret: string): FeishuLongConnection;
}

export const SANITIZED_LOGGER = {
  // SDK 会把错误对象/请求配置传给 logger；全部丢弃，仅留级别标记，避免认证头/Secret/事件进日志
  error: () => console.error('[feishu-sdk] error (details redacted)'),
  warn: () => console.warn('[feishu-sdk] warn (details redacted)'),
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** 真 SDK 适配：只在实例启用并 start/verify 时才构造；构造本身不联网。 */
export async function loadRealSdk(): Promise<FeishuSdk> {
  const Lark = (await import('@larksuiteoapi/node-sdk')) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const base = (appId: string, appSecret: string) => ({ appId, appSecret, domain: Lark.Domain.Feishu, appType: Lark.AppType.SelfBuild, logger: SANITIZED_LOGGER, loggerLevel: Lark.LoggerLevel.error });
  return {
    api(appId, appSecret) {
      const c = new Lark.Client(base(appId, appSecret));
      return {
        createMessage: (r) => c.im.message.create({ params: { receive_id_type: r.receiveIdType }, data: { receive_id: r.receiveId, msg_type: r.msgType, content: r.content, uuid: r.uuid } }),
        patchMessage: (r) => c.im.message.patch({ path: { message_id: r.messageId }, data: { content: r.content } }),
        uploadImage: async (bytes) => ({ code: 0, data: await c.im.image.create({ data: { image_type: 'message', image: bytes } }) }),
        uploadFile: async (r) => ({ code: 0, data: await c.im.file.create({ data: { file_type: 'stream', file_name: r.fileName, file: r.bytes } }) }),
        verifyToken: () => c.auth.tenantAccessToken.internal({ data: { app_id: appId, app_secret: appSecret } }),
      };
    },
    longConnection(appId, appSecret) {
      const ws = new Lark.WSClient({ ...base(appId, appSecret), autoReconnect: true });
      return {
        async start(h) {
          const dispatcher = new Lark.EventDispatcher({ logger: SANITIZED_LOGGER, loggerLevel: Lark.LoggerLevel.error })
            .register({ 'card.action.trigger': h.cardAction, 'im.message.receive_v1': h.message });
          // 注意：SDK start 不等待握手完成；状态记作“长连接已启动”，不是“已确认连通”
          await ws.start({ eventDispatcher: dispatcher });
        },
        close() { try { ws.close?.({ force: true }); } catch { /* 已关闭 */ } },
      };
    },
  };
}
