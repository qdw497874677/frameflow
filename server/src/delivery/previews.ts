/**
 * 不可变派发预览（F11）。零发送：本服务不持有任何连接器端口。
 *
 * - 预览绑定照片快照、项目、参数、目标、策略与连接器配置 revision，默认 10 分钟期限。
 * - 用户显式选择的目标必须在服务器允许集合内（实例启用、目标存在、目标 projectIds 含该项目）；
 *   未选择时按策略推荐；都没有则为空并给出 NO_TARGET 警告（仅应用内），不默认发所有连接器。
 * - check() 用当前状态重算：照片/权限/策略变化 → PREVIEW_STALE，必须重新预览，绝不静默换目标。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectorConfigDocument } from '../connectors/types.ts';
import { key, matchTargets } from './policies.ts';
import type { DeliveryPreview, DispatchParams, PolicyDocument, PreviewCheck, PreviewTarget, TargetRef } from './types.ts';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS = 1000;

export interface PreviewState {
  readonly connectors: ConnectorConfigDocument;
  readonly policies: PolicyDocument;
}

export interface PreviewRequest {
  readonly projectId: string;
  readonly photoIds: readonly string[];
  readonly params: DispatchParams;
  /** undefined = 按策略推荐；[] = 明确仅应用内 */
  readonly targets?: readonly TargetRef[];
}

export type PreviewResult =
  | { readonly ok: true; readonly preview: DeliveryPreview }
  | { readonly ok: false; readonly code: 'EMPTY_SELECTION' | 'TARGET_NOT_ALLOWED'; readonly target?: TargetRef };

function resolveTarget(state: PreviewState, projectId: string, t: TargetRef): PreviewTarget | null {
  const inst = state.connectors.instances.find((i) => i.id === t.connectorId);
  if (!inst?.enabled) return null;
  const target = inst.targets.find((x) => x.id === t.targetId);
  if (!target || !target.projectIds.includes(projectId)) return null;
  return { connectorId: t.connectorId, targetId: t.targetId, label: target.label };
}

function fingerprint(p: Omit<DeliveryPreview, 'revision' | 'previewId' | 'createdAt' | 'expiresAt' | 'warnings'>): string {
  const canon = JSON.stringify([p.projectId, [...p.photoIds], p.params, p.targets.map((t) => [t.connectorId, t.targetId, t.label]), p.policyRevision, p.connectorRevision]);
  return createHash('sha256').update(canon).digest('hex');
}

export class PreviewService {
  readonly #previews = new Map<string, DeliveryPreview>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  create(req: PreviewRequest, state: PreviewState): PreviewResult {
    if (!req.photoIds.length) return { ok: false, code: 'EMPTY_SELECTION' };
    const photoIds = [...new Set(req.photoIds)].sort();
    const wanted = req.targets ?? matchTargets(state.policies, req.projectId, 'task.dispatched');
    const seen = new Set<string>();
    const targets: PreviewTarget[] = [];
    const warnings: string[] = [];
    for (const t of wanted) {
      if (seen.has(key(t))) continue;
      seen.add(key(t));
      const r = resolveTarget(state, req.projectId, t);
      if (r) targets.push(r);
      else if (req.targets) return { ok: false, code: 'TARGET_NOT_ALLOWED', target: t };
      else warnings.push('POLICY_TARGET_UNAVAILABLE');
    }
    if (!targets.length) warnings.push('NO_TARGET');
    const now = this.#now();
    const body = { projectId: req.projectId, photoIds, photoCount: photoIds.length, params: { ...req.params }, targets, policyRevision: state.policies.revision, connectorRevision: state.connectors.revision };
    const preview: DeliveryPreview = deepFreeze({
      previewId: `pv_${randomUUID()}`, revision: fingerprint(body), createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(), ...body, warnings: [...new Set(warnings)],
    });
    this.#gc(now);
    this.#previews.set(preview.previewId, preview);
    return { ok: true, preview };
  }

  get(previewId: string): DeliveryPreview | undefined { return this.#previews.get(previewId); }

  /** 确认前复核：期限、revision、以及当前照片/权限/策略状态下重算是否一致 */
  check(previewId: string, revision: string, state: PreviewState, currentPhotoIds: readonly string[]): PreviewCheck {
    const p = this.#previews.get(previewId);
    if (!p) return { ok: false, code: 'PREVIEW_NOT_FOUND' };
    if (this.#now() >= Date.parse(p.expiresAt)) return { ok: false, code: 'PREVIEW_EXPIRED' };
    if (p.revision !== revision) return { ok: false, code: 'PREVIEW_REVISION_MISMATCH' };
    const photos = [...new Set(currentPhotoIds)].sort();
    if (JSON.stringify(photos) !== JSON.stringify(p.photoIds)) return { ok: false, code: 'PREVIEW_STALE', detail: 'photos' };
    if (state.policies.revision !== p.policyRevision) return { ok: false, code: 'PREVIEW_STALE', detail: 'policy' };
    for (const t of p.targets) {
      const r = resolveTarget(state, p.projectId, t);
      if (!r || r.label !== t.label) return { ok: false, code: 'PREVIEW_STALE', detail: 'target' };
    }
    if (state.connectors.revision !== p.connectorRevision) return { ok: false, code: 'PREVIEW_STALE', detail: 'connector' };
    return { ok: true, preview: p };
  }

  /** 取消：只丢弃预览，零发送 */
  cancel(previewId: string): boolean { return this.#previews.delete(previewId); }

  #gc(now: number): void {
    for (const [id, p] of this.#previews) if (now >= Date.parse(p.expiresAt)) this.#previews.delete(id);
    while (this.#previews.size >= MAX_PREVIEWS) this.#previews.delete(this.#previews.keys().next().value!);
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
}
