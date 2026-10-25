# Spec: connector-core

状态：规格及任务清单已获用户批准；正在实施离线风险验证，尚未启用连接器。上位规格：[SPEC.md](SPEC.md)。本模块提供接口，后续模块依赖它，不反向依赖飞书。所有本文件代码为拟议接口。

## Objective

让管理员管理多个连接器实例、接收目标和权限；提供与平台无关的发送/更新及事件入口。首版仅实现国内飞书适配，保留现有 inapp，不做第三方插件加载器。

用户故事：新增实例 → 填 App ID 与 Secret 环境变量引用 → 配置允许的群/用户和项目 → 验证连接 → 启用。每个实例可有多个群/个人目标。状态为 disabled/connecting/connected/degraded/error，附脱敏原因、最近连接时间；不把“凭据有效”误标为“事件订阅已配置”。

## Provider contract

```ts
export interface ConnectorTarget {
  id: string;
  connectorId: string;
  label: string;
  kind: 'group' | 'user';
  externalId: string; // 平台适配器解释；飞书为 chat_id/open_id
  projectIds: string[];
  allowedActorIds: string[]; // 群卡片也验证实际操作者
  canAnnotate: boolean;
  canRequestJpeg: boolean;
}
export interface ActorIdentity {
  connectorId: string;
  tenantId: string;
  actorId: string;
}
export interface ConnectorPort {
  send(input: SendInput): Promise<DeliveryResult>;
  update(input: UpdateInput): Promise<DeliveryResult>;
  start(onEvent: (event: ConnectorEvent) => Promise<EventAck>): Promise<void>;
  stop(): Promise<void>;
}
```

`SendInput`：服务端已授权的 targetId、稳定 intentId、语义内容（任务入口/挑片/进度/文件）、服务器生成的交互 sessionId。`UpdateInput` 加已记录 messageId，不能任意更新别人的消息。语义内容不包含随意 URL/磁盘路径；文件通过内部受控媒体引用读取。`DeliveryResult` sent(messageId)/failed(code,retryable)/unknown(code)，定义见总规格。

`ConnectorEvent`：可信 SDK 认证后的 envelope + 未可信业务数据。包含实例/租户/实际用户、来源会话、messageId/eventId（如平台提供）、动作参数。`EventAck` 仅表示拒绝/受理及 toast；业务完成是后续状态，不能提前说“保存成功”。

`ConnectorInstance` 至少包含 id、kind=feishu、label、appId、secretEnv、enabled、targets、creatorActorIds、creatorProjectIds；状态由运行时维护而非用户写入。身份以 `(connectorId, tenantId, actorId)` 唯一，不跨应用拼接 open_id。

## Authorization

- 默认拒绝，所有请求校验连接器启用、实例租户匹配、来源 target 与实际用户授权。帮助/任务入口/创建预览不要求已有投递：创建额外检查创建权限及允许项目；任务操作才要求任务已投递给该 target，照片操作另要求照片在任务快照且当前仍可访问。
- 确认与重新标记必须检查 `canAnnotate`；原图请求检查 `canRequestJpeg`。用户在 allowlist 内不等于拥有所有操作权限，排队动作执行前仍复验这些权限。
- 群：来源 chat_id 必须匹配配置目标，实际用户须在该目标 allowedActorIds 中；私聊：目标 open_id 与实际用户匹配。身份取 SDK envelope，绝不取卡片 value 自报。
- 当前成员关系由飞书合法事件来源与消息上下文保证的部分不再自建同步；若拿不到必须的可信会话信息，拒绝操作，不推断“有卡片就有权”。转发卡片不能扩权。
- 创建权限额外检查 creatorActorIds 与 creatorProjectIds；选择其它目标还须在服务器允许的目标集合内。
- 授权每次执行前重新校验：撤销 allowlist 或停用实例，对已发旧卡立即生效。停用停止发送和接收，不删除历史任务与标记。
- 新连接器管理接口仅允许已认证的管理 session；开启外传前要求配置应用密码。现有免认证本地选片仍可用，但不能在公开免认证状态启用连接器。普通 API token、范围 token、飞书用户均不能改连接器配置。

## Storage and API shape

沿用 dataDir，拟新增 `connectors.json`（非密钥配置，原子写入替换，目录0700/文件0600）。Secret 存部署环境变量，文件只存变量名；设置页输入引用名不回显实际值。UI读取返回 `secretConfigured`，永不回传 Secret。未启用时也不连飞书。配置引用已有且使用中的 appId 拒绝重复实例。

拟议管理接口（路径均在 `/api/v1` 下，实施时先同步 OpenAPI/前端 DTO）：
- `GET /connectors` → `{items:[sanitized config + status]}`，支持 limit/cursor。
- `POST /connectors` → 创建默认 disabled；body 不允许原始 Secret。
- `PATCH /connectors/{id}` → 配置/启停；携带 expectedRevision，避免覆盖并发修改。
- `DELETE /connectors/{id}` → 被策略或活跃派发引用时409；先停用/解绑，不级联删任务。
- `POST /connectors/{id}/test` → 仅凭据/连接验证，无消息；“发送测试卡片”是另一个明确确认操作，仅对专用已授权目标。
- `GET /connectors/{id}/targets` → 配置的目标，不为方便搜索索取整个通讯录。

统一边界返回：400非法参数、401未认证、403无权、404不可见对象、409版本/引用冲突；保留 `{error: string, code?: string}` 兼容。列表不会混入密钥。`/capabilities` 可增加连接器摘要，`/channels` 原有 inapp 保持。

## Commands

从仓库根执行：
```bash
(cd server && npm run typecheck)
(cd web && npm run typecheck)
(cd web && VITE_API_BASE=/api/v1 npm run build)
# 待新增测试
(cd server && node --test tools/connector-core.test.mjs)
node tools/e2e-connectors.mjs
```

## Project Structure

- `server/src/connectors/types.ts`：本模块提供的共享类型与生命周期接口。
- `server/src/connectors/registry.ts`：实例注册/状态，不引入平台业务逻辑。
- `server/src/connectors/config.ts`：配置持久化与脱敏。
- `server/src/connectors/access.ts`：目标/身份授权。
- `web/src/features/connectors/`：设置页连接器区块。
- `server/tools/connector-core.test.mjs`：独立临时配置测试。

## Code Style

沿用 SPEC.md：显式联合类型、strict TS、后端 `.ts` 导入，UI中文；纯授权函数返回 typed decision，不以异常消息字符串推断权限；外部输入在边界一次校验，密钥由私有运行时读取。

## Testing Strategy / Acceptance

- CC-01：两实例各有群/私聊目标，启动/停用互不影响；同 appId 重复启用被拒。
- CC-02：API、错误日志、浏览器网络响应不出现 Secret；未知环境变量和错误凭据可诊断。
- CC-03：未认证/普通 token/范围 token/非管理员无法修改配置；密码未设不能启用。
- CC-04：跨实例 open_id、其它租户、非允许用户、转发卡片、其它任务/照片均拒绝且无写入/上传。
- CC-05：配置原子替换失败不丢旧配置；重启恢复配置不恢复到假 connected。
- CC-06：授权撤销后旧卡/排队动作失效，历史标注不丢。
- CC-07：测试连接不发送任何内容；显式测试消息只发确认目标。
- CC-08：无历史任务的授权创建者能完成首次创建；普通允许用户无创建权限时不能创建。
- CC-09：allowlist 内但 canAnnotate=false 的用户，通过按钮/文字命令都不能写标注；排队后撤销该权限也不能写。

## Boundaries

Always：最小权限、运行状态真实、启用前校验配置、执行时复验权限。Ask first：通讯录遍历、跨租户/外部群、另建账号体系或密钥库。Never：公开凭据、默认所有群/用户可用、把配置失败悄悄回退成全开放。

## Open Questions

测试租户/目标待管理员提供；不阻塞规格审核。接口类型需要在 Plan 阶段与 SDK 明确映射后纳入唯一 OpenAPI 契约，不在此阶段改实现。
