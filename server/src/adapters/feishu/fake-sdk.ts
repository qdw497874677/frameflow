/**
 * 离线假飞书 SDK（仅浏览器 e2e，F30）：FRAMEFLOW_FEISHU_SDK=fake-e2e 时注册。
 * 不触网；每次调用以 jsonl 追加到 FRAMEFLOW_FAKE_SDK_LOG（不含 Secret），供 e2e 断言「零误发」。
 */
import { appendFileSync } from 'node:fs';
import type { FeishuSdk } from './client.ts';

export function fakeE2eSdk(logPath: string | undefined): FeishuSdk {
  let n = 0;
  const log = (op: string, extra: Record<string, unknown> = {}) => {
    if (logPath) appendFileSync(logPath, JSON.stringify({ op, ...extra }) + '\n');
  };
  return {
    api: (appId) => ({
      createMessage: async (r) => { log('createMessage', { appId, receiveId: r.receiveId, msgType: r.msgType }); return { code: 0, data: { message_id: `om_fake_${++n}` } }; },
      patchMessage: async () => { log('patchMessage', { appId }); return { code: 0 }; },
      uploadImage: async () => { log('uploadImage', { appId }); return { code: 0, data: { image_key: `img_fake_${++n}` } }; },
      uploadFile: async () => { log('uploadFile', { appId }); return { code: 0, data: { file_key: `file_fake_${++n}` } }; },
      verifyToken: async () => { log('verifyToken', { appId }); return { code: 0 }; },
    }),
    longConnection: () => ({ start: async () => undefined, close: () => undefined }),
  };
}
