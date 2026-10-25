# Spec: delivery-policy

状态：规格及任务清单已获用户批准；基础风险验证进行中，本模块尚未实现。上位规格：[SPEC.md](SPEC.md)。依赖 [connector-core](SPEC-connector-core.md) 提供的目标、权限与发送端口；不 import 飞书实现。

## Objective

网页确认任务时决定是否走连接器。策略负责推荐目标，用户最终确认负责授权本次投递；策略不是绕过确认的后台群发规则。

- 创建/派发批注任务时默认可选“仅应用内”，不改变现有 inapp 流程。
- 勾选连接器后，按项目与事件匹配策略，预览并允许调整目标；没有匹配目标时要求选择，不能默认发所有连接器。
- 首版事件为 `task.dispatched`、`task.completed`。完成通知只面向本任务确认时批准的目标；当时没有启用完成通知，不因后来修改策略而自动外传。
- 普通打星、翻片、跳过不触发策略投递。卡片确认后刷新当前消息是交互响应，不是再次派发任务。

## Boundary contract

```ts
export interface DeliveryPolicy {
  id: string;
  enabled: boolean;
  projectIds: string[]; // 明确列出，不把空数组理解为所有项目
  event: 'task.dispatched' | 'task.completed';
  targets: { connectorId: string; targetId: string }[];
  revision: number;
}
export interface DeliveryPreview {
  previewId: string;
  revision: string;
  expiresAt: string;
  photoCount: number;
  targets: { connectorId: string; targetId: string; label: string }[];
  warnings: string[];
}
```

提供给网页及飞书交互层的统一业务入口：`previewDispatch`、`confirmDispatch`、`listDeliveries`、`retryDelivery`。具体 TypeScript 签名在 Plan 阶段落定；消费者不能直接调用连接器跳过权限/确认。

预览需绑定不可变照片快照、项目、任务参数、目标列表与策略版本。有效期默认 10 分钟；确认时重新检查授权、目标启用状态、照片可访问性。范围、策略或权限变化返回409及重新预览提示，不静默替换目标或照片。现有 `/jobs?mode=plan` 不落库语义保留；连接器派发可额外保存短期确认上下文，不把 plan 当实际任务。

确认输入包含 previewId、revision、稳定 requestId、是否完成通知及已展示的外传提示确认。requestId 仅用于同一次确认重试：同 id 同内容返回已有任务/投递；同 id 不同内容409。仅应用内也只能创建一次任务。

## Target snapshot and result semantics

- 最终目标按 `(connectorId,targetId)` 去重，固定为任务投递快照。每个目标拥有独立 deliveryId 和独立游标，但共享任务结果。
- `pending → sending → sent | failed | unknown`。sent 表示平台接受，不代表用户读过或已确认照片。
- 每目标保存 intentId、目标快照、状态、消息组成部分、尝试次数、脱敏错误、时间。每个必要组成部分（如入口消息、当前卡片；若拆发则另含图片消息）有稳定 partId/发送意图、独立状态和 messageId；所有必要部分 sent 才将目标记为 sent。部分失败只重试失败部分，unknown 部分遵守不确定结果规则，不重发成功图片/入口。它是一次目标投递的有限组成，不是通用消息系统。pending/sending 与发送结果需要持久化，重启不能把不确定的发送自动当失败重发。
- 发送前重新校验启用与授权；失效目标标失败，其他目标继续。某目标失败不取消任务、不回滚其它成功目标。
- 自动恢复只处理已知未发送的 pending。sending 遗留或网络超时后无法判断服务端是否接收时记 unknown；可核实时先核实，无法核实则在网页解释重复风险，经用户明确确认才重新发送。
- 已明确失败且可重试的目标支持单独重试；不重发 sent 目标。SDK 自有连接/网络行为不另包无限重试。
- 新增投递目标是一次新的确认，不通过改策略给旧任务偷偷扩大发送范围。
- 任务完成通知以任务完成代次和目标组成稳定意图；重复完成事件不重复发。重新标记不自动再发完成通知，除非另有明确再次通知操作。

## Storage and proposed API

数据放 dataDir，拟用 `delivery-policies.json` 原子配置与 `deliveries.jsonl` 最小追加日志；不建立通用消息队列。恢复以 requestId/intentId 重建最后状态。确认与建任务之间即使进程中断，也应从同一确认记录恢复/返回同一任务，不能新建第二个。

拟议 `/api/v1` 管理接口：
- `GET/POST /delivery-policies`、`PATCH/DELETE /delivery-policies/{id}`；修改带 expectedRevision。
- `POST /delivery-previews`：读取当前选择集、参数、候选目标，返回 DeliveryPreview，零外部发送。
- `POST /delivery-confirmations`：确认上述快照，返回 `{job, deliveries}`；异步投递，返回不代表送达。
- `GET /jobs/{id}/deliveries`：逐目标状态。
- `POST /deliveries/{id}/retry`：只重试指定目标；unknown 状态要求额外确认重复风险。

这些管理接口用已认证管理 session；飞书创建任务经可信内部身份上下文调用同一服务，不转授管理 cookie。现有 `/jobs` 的应用内调用保持兼容。所有新线格式实施前进入 OpenAPI，API不能接任意 chat_id 或磁盘路径。

## Web interaction

派发对话框增加连接器开关、匹配策略提示、目标复选、完成通知选项与外传提示：默认上传压缩预览，获授权接收者可请求 JPG 原文件。每目标可展开其可操作人/原图权限摘要。

确认后显示任务与逐目标状态；不要把“任务已创建”混成“所有目标发送成功”。配置列表与发送错误都需中文可诊断，凭据/完整批注 token 不显示在错误中。

## Tech Stack / Project Structure

沿用严格 TS、Fastify、JSONL、React；不增加调度框架。
- `server/src/delivery/`：策略匹配、确认快照、投递状态。
- `web/src/features/connectors/`：策略管理。
- `web/src/features/jobs/DispatchAnnotate.tsx`、任务详情：确认与结果。
- `server/tools/delivery-policy.test.mjs`、`tools/e2e-connectors.mjs`：隔离测试。

## Commands

```bash
(cd server && npm run typecheck)
(cd web && npm run typecheck)
(cd web && VITE_API_BASE=/api/v1 npm run build)
# 待新增，不对真实目标发送
(cd server && node --test tools/delivery-policy.test.mjs)
node tools/e2e-connectors.mjs
```

## Code Style

策略匹配为纯函数；发送副作用经 connector-core 端口注入。采用总规格的 discriminated union，不用一个 success boolean 掩盖 unknown。文案中文，接口字段稳定，不泄漏平台 SDK 类型。

## Testing Strategy / Acceptance

- DP-01：仅应用内、取消预览、失效预览、普通打标都不调用发送端口。
- DP-02：项目+事件匹配正确，多规则重复目标只发一次；用户删掉的目标不发。
- DP-03：两个实例三个目标，部分成功部分失败，重试只触及失败目标；unknown 不自动重发。
- DP-04：同 requestId 重复确认/并发确认只建一任务；确认保存后、建任务后、发送中任意点重启可对账。
- DP-05：确认前修改策略、移除照片、收回授权返回可理解的冲突；不把旧同意用于新目标。
- DP-06：完成事件重复、不完整任务、重新标记，均不造成重复完成通知。
- DP-07：390px 页面目标和结果可操作，无横向溢出；主按钮≥44px；状态可由读屏获取。
- DP-08：入口/图片成功、卡片失败或超时、随后重启，只恢复未成功部分，不重复已发部分、不误报整目标成功。

## Boundaries

Always：先确认后外传，目标逐一对账，重试不影响成功目标，错误如实。Ask first：无确认自动创建/群发策略、通用规则引擎、队列或跨进程调度。Never：把已发送附件当可撤回本地数据、静默追加接收人、把所有超时都记成确定失败。

## Open Questions

没有新增产品范围问题。确认记录与现有任务日志的可恢复写入顺序须在 Plan 阶段明确并接受故障注入验证；不得靠多文件“应该一起成功”代替恢复协议。
