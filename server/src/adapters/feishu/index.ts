/**
 * 飞书适配器的唯一入口：组装根与 HTTP 层只从这里拿飞书能力。
 *
 * - `loadFeishuSdk`：按 FRAMEFLOW_FEISHU_SDK 选真实 / 离线假 SDK / 不注册；
 * - `feishuConnector`：连接器工厂（发送、更新、媒体上传）；
 * - `openFeishuInteraction`：卡片交互控制器 + 任务入口卡发送（会话与游标落 dataDir）。
 */

import type { ConnectorFactory } from '../../domain/connectors/types.ts';
import type { PhotoRecord } from '../../domain/photo.ts';
import { UnknownOutcome, type Transport } from '../../application/delivery/runner.ts';
import type { DeliveryMessage } from '../../application/delivery/dispatcher.ts';
import { fileOf } from '../../domain/library/photo-files.ts';
import { ActionLog } from './actions.ts';
import type { CardModel } from './cards.ts';
import { loadRealSdk, type FeishuSdk } from './client.ts';
import { FeishuController, type ControllerDeps } from './controller.ts';
import { CursorStore } from './cursors.ts';
import { fakeE2eSdk } from './fake-sdk.ts';
import { JpegLog } from './jpegs.ts';
import { MediaError } from './media.ts';
import { SessionStore } from './sessions.ts';
import { feishuFactory, type CardResolver } from './transport.ts';

export type { CardModel, FeishuController, FeishuSdk };

/** `disabled` → 不注册；`fake-e2e` → 离线假 SDK（只记录调用，不触网）；其余 → 动态加载真实 SDK */
export async function loadFeishuSdk(mode: string | undefined, fakeLog: string | undefined): Promise<FeishuSdk | null> {
  if (mode === 'disabled') return null;
  return mode === 'fake-e2e' ? fakeE2eSdk(fakeLog) : loadRealSdk();
}

/** 连接器要用到的照片库能力 */
export interface FeishuPhotoSource {
  get(id: string): PhotoRecord | undefined;
  readonly thumbs: { thumb(rec: PhotoRecord, size: 2048): Promise<{ path: string; etag: string }> };
}

export function feishuConnector(sdk: FeishuSdk, lib: FeishuPhotoSource, resolve: CardResolver): ConnectorFactory {
  return feishuFactory({
    sdk: () => sdk,
    resolve,
    preview: async (photoId) => {
      const rec = lib.get(photoId);
      if (!rec) throw new Error('PHOTO_NOT_FOUND');
      const { path, etag } = await lib.thumbs.thumb(rec, 2048);
      return { path, signature: etag };
    },
    // F28：只取 JPEG 变体；RAW/HEIC-only/视频没有 jpeg → 拒绝（不转码、不用预览兜底）
    original: async (photoId) => {
      const rec = lib.get(photoId);
      const f = rec ? fileOf(rec, 'jpeg') : null;
      if (!f || f.mime !== 'image/jpeg') throw new MediaError('JPEG_UNSUPPORTED');
      return { path: f.path, fileName: f.name };
    },
  });
}

export type FeishuInteractionDeps = Omit<ControllerDeps, 'sessions' | 'actions' | 'cursors' | 'jpegs'>;

export interface FeishuInteraction {
  readonly controller: FeishuController;
  /** 真实外传：入口卡带 session（按钮只有不透明 sessionId）；发出后绑定消息与该目标游标 */
  readonly transport: Transport<DeliveryMessage>;
}

export function openFeishuInteraction(dataDir: string, deps: FeishuInteractionDeps): FeishuInteraction {
  const sessions = new SessionStore(dataDir);
  const cursors = new CursorStore(dataDir);
  const controller = new FeishuController({ ...deps, sessions, cursors, actions: new ActionLog(dataDir), jpegs: new JpegLog(dataDir) });
  const transport: Transport<DeliveryMessage> = {
    send: async (r) => {
      const inst = deps.config().instances.find((c) => c.id === r.connectorId);
      const session = sessions.create({ kind: 'task-entry', connectorId: r.connectorId, tenantId: inst?.tenantId ?? '', targetId: r.targetId, jobId: r.jobId, photoId: null, revision: null, generation: null });
      const completed = r.part.kind === 'task.completed';
      const content = completed ? { type: 'progress' as const, taskId: r.jobId } : { type: 'task-entry' as const, taskId: r.jobId };
      const out = await deps.send(r.connectorId, { targetId: r.targetId, intentId: r.intentId, content, sessionId: session.sessionId });
      if (out.status === 'sent') {
        if (!completed) {
          sessions.bindMessage(session.sessionId, out.messageId);
          cursors.set({ jobId: r.jobId, targetId: r.targetId, photoId: null, messageId: out.messageId, sessionId: session.sessionId });
        }
        return { messageId: out.messageId };
      }
      if (out.status === 'unknown') throw new UnknownOutcome(out.code);
      throw new Error(out.code);
    },
  };
  return { controller, transport };
}
