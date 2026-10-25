# Spec: feishu-connector

状态：规格及任务清单已获用户批准；正在验证官方SDK，不连接真实飞书。上位规格：[SPEC.md](SPEC.md)。实现 [connector-core](SPEC-connector-core.md) 端口，不解释星级/任务规则，也不自行选择投递目标。

## Objective

国内飞书企业自建应用机器人，通过官方 `@larksuiteoapi/node-sdk` 的 API Client 与 WSClient 完成消息、图片、附件、卡片传输和事件接收。首版不接国际 Lark、Webhook 机器人、OAuth 用户登录或公网回调服务器。

实例使用 App ID + Secret 环境变量引用。机器人能力、应用权限、可用范围、事件订阅与卡片回调由管理员在飞书后台配置；FrameFlow 提供检查清单，不能替租户管理员自动授权。

## SDK responsibilities vs application responsibilities

交给 SDK：连接建立、重连、鉴权协议、官方事件解码/分发与其明确提供的重试行为。使用 `EventDispatcher` 接收新版 `card.action.trigger` 和消息接收事件；不使用旧版卡片回调。

FrameFlow：实例生命周期、状态脱敏、业务 envelope 校验、向内部事件端口转发、上传限额预检、发送结果归类、最小业务去重。不得宣称 SDK 自动保证跨重启幂等、用户授权或任务一致性。

- 每实例一个 WSClient；平台长连接为集群分配而非广播，首版单服务进程。
- 卡片回调必须在官方 3 秒期限内响应。入口只做快速校验及最小持久化受理，慢 I/O、上传和卡片构建异步执行；预算内无法可靠受理则明确失败，不显示“已保存”。
- 队列仅为应用内有界执行与已有业务日志恢复，不引入消息中间件。过载拒绝受理并提示重试。
- 长连接断开显示 degraded/connecting，不能据此声称出站 HTTP 发送也一定不可用。

## Media and card transport

### 默认预览

读取现有受控缩略图/预览管线，不把带密钥的 URL 交给飞书下载。上传 JPEG 压缩预览取得 image_key，再嵌入交互卡片；若平台渲染必须拆成图片消息+卡片，仍应作为一组投递记录处理，不改变逐张确认语义。

预览目标最长边≤2048，非零、≤10 MB、符合官方像素限制；不能满足时明确失败，不上传原片作为兜底。视频项如进入任务仅用现有视频封面参与标注，不发送视频原文件。

### 按需 JPG 原图

只有经业务层批准的显式 request-jpeg 意图才读取该 PhotoRecord 的 JPEG FileRef：
- 使用 `file_type: stream` 上传到 IM 文件接口并发送文件消息；保留原文件字节和合法文件名，不走图片重编码路径。
- 大小非零且≤30 MB（本次官方接口限额）；超出时提示限制，可提供已配置且可访问的网页入口，不改走 Drive 上传或自动压缩。
- 没有 JPEG 则拒绝；RAW-only、HEIC-only 不能被重命名为 JPG。
- 发送前检查任务授权与照片当前状态：已取消任务、失联、照片进回收站、路径不在受控项目内均拒绝。用户/卡片不能传文件路径。
- 默认发送到请求所在、已登记的目标；私聊请求不广播回所有目标，群请求应提示附件对该群可见。

### 缓存与限制

image_key/file_key 只在同一连接器应用内缓存，键包含源文件身份与变更签名；平台报失效时重新上传，不能跨 appId 复用。缓存用于省上传，不是权限缓存，每次发送仍重新授权。

沿用平台限流提示及 SDK 明确提供的机制；不发无限重试洪泛。服务端消息 uuid ≤50 字符且仅提供一小时去重窗口，必须映射稳定 intentId，不能代替持久业务记录。发送后超时按 unknown 返回，不盲目生成新 uuid 重发。

## Callback contract and card updates

适配器将 SDK envelope 转为 connector-core 的 ConnectorEvent：实例、租户、真实用户、可信会话/messageId、平台 eventId（可用时）以及 action payload。action.value 必须为 object；payload 只包含不透明 sessionId/actionId 与必要表单字段，签名或服务端绑定防篡改。业务目标、照片路径和操作者不从客户端自行推断。

支持立即 toast/受理反馈，业务完成后更新已有卡片；旧卡刷新失败不会撤销已落盘标注，状态须可通过进度查询恢复。

官方期限：交互30天、卡片更新14天；延迟回调 token 30分钟且最多两次，并需回调响应后使用。不能存该 token 作为永久更新句柄。超过可更新期限或消息不存在时，只有合法用户显式“继续/刷新”等操作才发送新卡，并停用旧业务 session；不能在后台不断补发。

具体采用消息更新还是卡片实体更新 API，在 Plan 阶段用锁定 SDK 版本证明群聊/私聊与当前卡片 schema 可用；不能承诺任意旧卡可更新。

## Provisioning and observability

设置页显示连接状态、脱敏错误码、最近事件/连接时间；日志记录 connectorId/intentId/messageId/耗时/状态，不写 Secret、认证头、完整范围链接、原图片内容或无关聊天正文。业务需审计的用户ID仅存必要记录，展示用配置标签，原图外传不可由本地撤销保证收回。

最小权限清单以实际 API 官方权限表为准：发送消息/机器人能力、消息接收所需订阅、图片与文件上传、卡片回调。不得为了方便申请通讯录全量或群消息全量读取；群聊仅处理 @机器人 的明确命令，私聊仅处理发给应用的消息。

网页地址未配置或不可达时隐藏“打开网页”，核心卡片动作仍可完成。

## Tech Stack / Project Structure

官方 Node SDK 候选 **1.76.0**（本次 registry latest）；实施前审计并锁定。其他栈沿用 SPEC.md。
- `server/src/connectors/feishu/client.ts`：SDK 生命周期与配置。
- `server/src/connectors/feishu/media.ts`：受控上传/限额/应用内缓存。
- `server/src/connectors/feishu/cards.ts`：语义内容到飞书卡片类型。
- `server/src/connectors/feishu/events.ts`：可信 envelope 适配。
- `server/tools/feishu-connector.test.mjs`：假 SDK 合约回归。

## Commands

```bash
(cd server && npm run typecheck)
# 待新增：假 SDK，不使用真实凭据
(cd server && node --test tools/feishu-connector.test.mjs)
# 新增依赖后审计，不能自动强制修复
(cd server && npm audit)
```

真实联调脚本/命令在 Plan 阶段定义，要求显式 opt-in、专用测试目标；本阶段不连接飞书。

## Code Style

```ts
// 拟议：SDK 类型留在适配器，调用方只看到平台无关结果。
async function sendCard(input: SendInput): Promise<DeliveryResult> {
  // authorize/resolve target outside adapter; adapter validates platform mapping.
  return transport.send(input);
}
```

遵循 strict TS、错误分类和配置脱敏；不复制 SDK 内部代码、不自写 WebSocket 协议。

## Testing Strategy / Acceptance

- FC-01：fake SDK 验每实例独立生命周期、官方国内域名配置、停用关闭连接、坏配置无明文泄漏。
- FC-02：消息/新版卡片回调正确适配；模拟慢业务仍在3秒内反馈受理或明确失败。
- FC-03：默认仅压缩预览上传；图片/附件超限和空文件拒绝，RAW-only 不上传；JPG 文件字节 hash 与源一致。
- FC-04：open_id/chat_id 映射正确；同源文件不同应用不复用平台 key。
- FC-05：明确失败/限流/超时 unknown 区分，uuid 稳定且满足官方长度；无无限重试。
- FC-06：超期卡片、无效延迟 token、已删除消息有可恢复提示；更新失败不伪造未保存结果。
- FC-07（真实环境必要）：专用应用群聊/私聊接收、按钮表单、长连接重连、预览可见、JPG 下载 hash 一致。没有此证据只能标“本地测试通过”，不能标平台验收完成。

## Boundaries

Always：查官方文档/锁定版本、复用 SDK、限定上传内容、清理临时文件、平台限制如实反馈。Ask first：Webhook 回退、Drive 大文件、额外消息权限、真实消息发送。Never：上传 RAW、传任意路径、记录凭据、将平台投递成功当已确认照片。

## Sources / Open Questions

官方链接和限额见 [SPEC.md §10](SPEC.md#10-官方资料与核实结论)。具体 SDK 字段/表单事件形状与权限名需测试应用核实；真实连接/下载验证是发布门槛，不是现在就申请用户 Secret。
