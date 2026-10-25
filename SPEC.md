# FrameFlow 飞书连接器规格

状态：**规格、技术计划及任务清单已获用户批准；正在实施离线风险验证，尚不支持真实飞书连接**。本文件是本次规格的总入口和能力图，不是已有功能说明。

## 1. Objective：目标与已确认范围

面向个人摄影师及其协作群：网页创建批注任务时确认是否通过连接器派发；按策略向一个或多个连接器的群聊或私聊目标发送图片与卡片，在飞书逐张确认、复核、重新标记和查看进度。不要求用户记命令或打开网页才能完成基本挑片。

用户已确认：
- 国内飞书企业自建应用机器人，使用官方 Node SDK 和长连接；不是群 Webhook 机器人。
- 网页确认任务是否走连接器；可以选择仅应用内处理。策略按项目与事件匹配，确认时可调整目标。
- 图片 + 卡片逐张确认；常用命令直接体现为按钮，文字命令辅助。支持群聊和私聊、创建任务、进度查询、继续、重新标记。
- 多目标共享同一个任务进度，不做每人独立评分；旧卡片不能静默覆盖更新结果。
- 默认压缩预览；点击指定按钮才额外发送对应 JPG/JPEG 原文件，不上传 RAW、不把 RAW 转换后冒充 JPG 原图。
- 允许的群/用户才能操作，创建任务另设权限；采用下列四模块边界。
- SDK 已提供的连接、重连、协议处理不重复实现。不自建消息中间件或通用重试框架；FrameFlow 只保存必要的业务授权、确认、投递结果与去重状态。

### 已有基础与需要补齐的差距

已有 `server/src/jobs/*` 任务层、`inapp` 通道、`/jobs/{id}/inbound`、独立 `/j?t=` 批注页、范围凭据、预览与 XMP/JSONL 标注。已有前端任务列表和派发入口。

**不能把现有接口直接套成飞书即宣称完成：**
- 当前 `server/src/jobs/service.ts` 只接受 running/interrupted 新回流，done 任务不能重新标记。
- 当前幂等依赖每项最新 clientRef，不能覆盖长期重放；现有按任务串行不等于跨任务/网页并发安全。
- `server/src/jobs/annotate.ts` 把不变标记/空回执算 skipped；这与“暂时跳过不算确认、零星明确确认算确认”不同。
- 当前没有原子版本检查，也没有飞书用户身份映射；批注链接是持有即授权，不是飞书实名登录。
以上是规格验收的一部分，不是交付后再补的优化。

## 2. 批准的能力图

| 模块 ID | 责任 | 依赖 | 规格 |
|---|---|---|---|
| `connector-core` | 实例配置、状态、接收目标、授权及通用端口 | 现有管理认证/配置 | [SPEC-connector-core.md](SPEC-connector-core.md) |
| `delivery-policy` | 确认前预览、目标快照、多目标投递与结果 | connector-core、现有任务 | [SPEC-delivery-policy.md](SPEC-delivery-policy.md) |
| `feishu-connector` | 官方 SDK、长连接、图片/文件/卡片传输与事件适配 | connector-core | [SPEC-feishu-connector.md](SPEC-feishu-connector.md) |
| `feishu-interaction` | 卡片/命令、共享进度、版本冲突、原图请求 | delivery-policy、feishu-connector、现有标注/任务 | [SPEC-feishu-interaction.md](SPEC-feishu-interaction.md) |

构建依赖方向：connector-core → delivery-policy 与 feishu-connector → feishu-interaction。统一装配在应用入口，不让策略 import 飞书实现，也不让适配器 import 交互控制器形成循环。本文与四份模块规格已一起通过审核，技术计划也已确认；当前进入 Implement，按任务清单先做离线风险验证。

## 3. 核心用户故事与成功标准

1. 管理员新增飞书连接器，配置凭据引用、允许的用户/群、可访问项目、目标；启用后看到真实连接状态。未启用时无连接、无发送。
2. 网页预览 N 张任务，勾选“通过连接器派发”，看到匹配策略、去重后的所有目标、将上传预览以及允许按需发送 JPG 原图的提示，再确认。取消确认或只预演绝不发消息。
3. 每个目标只收到任务入口与当前一张挑片卡片，不一次刷 N 张。卡片显示项目/任务、文件名、当前序号、共享已确认数、压缩预览、星级/待删控件及操作按钮。
4. 选择控件只是表单草稿；点击“确认并下一张”才落标、记实际操作者、增加一次确认计数。暂时跳过仅移动当前目标游标。明确确认零星同样算确认。
5. 同一任务投递到多个目标，共用结果与确认数，各目标可独立翻页；两人从同一版本确认时只接受一次，另一人收到冲突与刷新按钮。
6. 进度卡支持继续未确认、复核已确认、重新标记、刷新进度；入口卡可创建任务。创建需独立权限，先预览、后确认，不允许任意磁盘路径或任意投递目标。
7. “发送 JPG 原图”是显式新意图，只将对应 JPEG 字节作为文件附件发到当前已授权目标。无 JPEG、超平台限额、失联、已入回收站或无权限时给出明确原因，不降级为 RAW 或伪原图。
8. 多目标部分失败不撤销已创建任务、不重复成功目标；网页可见每目标状态。重启、重复回调不产生重复确认/进度。发送结果不确定时如实显示，不声称 exactly-once。
9. 不使用飞书的现有用户仍能选片、派发应用内任务；旧数据可读，未配置连接器时无外部网络活动。

## 4. Tech Stack

沿用仓库 Node ESM/原生 TypeScript、Fastify、React、现有 JSONL 存储与 sharp/ffmpeg 预览，不引入数据库、Redis、独立微服务或工作流引擎。

当前 manifest 范围：后端 Fastify ^5.12.5、sharp ^0.35.5、TypeScript ^7.0.2；前端 React ^19.3.0、Vite ^8.3.2、TypeScript ^5.9.0。运行验证以仓库实际支持的 Node 22.23.x 或更新兼容版本为准，不能仅凭 `>=22` 假定所有早期 Node 22 均可直跑 TS。

用户已授权新增官方 `@larksuiteoapi/node-sdk`。F01 已完成依赖/锁文件审计与离线类型、长连接事件验证，精确锁定 **1.76.0**；证据见 [SDK 验证记录](docs/feishu-sdk-validation.md)。未启用运行时连接，真实平台验收仍待授权联调。

部署边界：单 FrameFlow 实例/单写者。一 appId 一个 SDK 长连接实例；同 appId 重复配置拒绝，不能假设多个进程会广播收到同一事件。多副本支持不在本次范围。

## 5. Commands

以下从仓库根执行；现有命令可执行，新模块测试是**待实现交付物**，目前不可用。

```bash
# 现有静态验证与构建
(cd server && npm run typecheck)
(cd web && npm run typecheck)
(cd web && VITE_API_BASE=/api/v1 npm run build)
git diff --check
# 开发（本规格阶段不运行或改变服务）
(cd server && ./tools/dev.sh start)
# 已有隔离回归
(cd server && node tools/e2e-marks-durability.mjs)
(cd server && node tools/e2e-jobs.mjs)
(cd server && node tools/e2e-annotate.mjs)
node tools/e2e-project-navigation.mjs
# 待实现：默认假 SDK/独立临时库，不能向飞书发送
(cd server && node --test tools/connector-core.test.mjs)
(cd server && node --test tools/delivery-policy.test.mjs)
(cd server && node --test tools/feishu-connector.test.mjs)
(cd server && node --test tools/feishu-interaction.test.mjs)
node tools/e2e-connectors.mjs
# 发布前审计；不执行 audit fix --force
(cd server && npm audit)
(cd web && npm audit)
```

真实飞书联调是单独 opt-in 验收，必须先由用户提供专用测试应用/目标与发送许可；不得把聊天中的凭据复制到版本库。

## 6. Project Structure

计划新增（文件拆分可在 Plan 阶段调整，不改变模块 ID）：

```text
SPEC.md / SPEC-<module-id>.md       规格索引与模块边界
server/src/connectors/             通用端口、实例运行时、目标及授权
server/src/connectors/feishu/      SDK 适配、媒体、卡片传输
server/src/delivery/               策略、确认快照、逐目标投递记录
server/src/integrations/feishu/    卡片动作、命令和流程控制
web/src/features/connectors/      管理配置、状态、测试连接、目标与策略
server/tools/*connector*.test.mjs  假 SDK/本地文件系统回归
server/tools/feishu-interaction.test.mjs
tools/e2e-connectors.mjs           隔离浏览器回归
```

复用/扩展：`server/src/jobs/`、`server/src/core/marks.ts`、`server/src/api/server.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`web/src/features/jobs/`。线上线格式仍以 OpenAPI 为唯一真相，本轮只描述拟议接口，不提前把契约标成已实现。旧 `/channels` 保持兼容，不把连接器实例冒充业务 task kind。

## 7. Code Style

沿用严格 TypeScript、显式类型、后端相对导入带 `.ts`、不使用 enum/构造参数属性、用户文案中文。异步挂载 I/O，不在请求线程同步读原图。如下是**拟议风格示例，不是已导出的接口**：

```ts
export type DeliveryResult =
  | { state: 'sent'; messageId: string }
  | { state: 'failed'; code: string; retryable: boolean }
  | { state: 'unknown'; code: string };

export interface DeliveryTarget {
  connectorId: string;
  targetId: string; // 服务端已注册目标；不是客户端随意提供的 chat_id
}
```

外部参数在 API/SDK 事件入口校验；内部调用 typed service，不自调用 HTTP API 绕权限。错误保持现有 `{ error: string }` 兼容，可新增 `code`/`details`，不要破坏已有前端。

## 8. Testing Strategy

- Node 内置测试 runner + 可替换适配端口，假 SDK 检查参数与调用次数；文件系统测试全部 mkdtemp。
- 单元：策略匹配/目标去重、授权矩阵、动作映射、版本/幂等、图片格式与限额。
- 集成：日志写失败、进程重启、卡片陈旧、重复/乱序回调、网页与多个任务同时改同一照片、多目标部分失败及结果不确定。
- 浏览器：配置脱敏、确认开关、目标覆盖、上传提醒、逐目标状态与重试；桌面和 390px 无横向溢出，主要触控目标 ≥44px。
- SDK真实验收：专用应用、群和用户，只有通过 mock 并得到发送许可后运行；验群聊、私聊、长连接、按钮表单、图片与原 JPG 文件、重连、权限拒绝。
- 所有本规格编号验收必须有测试或明确的人工证据。不能用只有成功路径的测试代替并发/错误分支，也不能以无真实飞书环境为由宣称飞书端已验收。

## 9. Boundaries

**Always**：确认后才投递；凭据脱敏、SDK 日志净化；检查任务/照片/目标/实际点击者权限；预览与原图外传范围清晰；复用 SDK 连接能力；保留最小业务状态；测试不碰用户照片；写契约后实现；单实例业务锁与持久化顺序可重放。

**Ask first**：引入非官方 SDK 的新依赖/数据库/消息中间件、扩大飞书权限/通讯录范围、开放公网、跨租户或外部群、将原图群发到其它目标、RAW/视频原件发送、改变旧应用内批注语义、向真实用户发送测试消息。

**Never**：提交/回显/记录 Secret 或完整范围 token；用 SDK“送达”当作业务授权；无确认发送照片；客户端传任意路径/任意接收人；飞书操作永久删除；静默覆盖冲突；无限自动重试；宣称上传到飞书的文件会随本地任务撤销而自动收回。

## 10. 官方资料与核实结论

- [Node SDK 回调](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)：WSClient + EventDispatcher 支持 `card.action.trigger`，参数必须 object；长连接限企业自建应用，旧版卡片回调不支持；3 秒响应，集群模式非广播。
- [卡片回调与更新](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)：交互有效期 30 天、更新有效期 14 天；延迟 token 30 分钟且最多更新两次，延迟更新须在响应后。不得把该 token 当持久更新凭据。
- [上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)：图片非零且 ≤10 MB，非 GIF 分辨率 ≤12000×12000；默认压缩预览更小。
- [上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)：非零且 ≤30 MB，JPG 以 `file_type: stream` 文件上传而非图片消息重编码。
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)：私聊 open_id、群 chat_id；open_id 依应用而异；机器人要在群中/用户要在可用范围。发送 uuid ≤50 字符，同 uuid 一小时内最多成功一条，不能作为永久业务幂等。
- [官方 SDK](https://github.com/larksuite/node-sdk)、[本次 registry 版本](https://registry.npmjs.org/@larksuiteoapi/node-sdk/latest)。平台限制实现前再次核对；不能混用 Drive 大文件限额代替 IM 文件接口限额。

## 11. Open Questions / 实施验证门槛

无剩余产品范围问题；以下不是默认替用户做出的环境决定：
- 用户尚未提供测试 appId、环境变量形式的 Secret、测试 chat_id/open_id 与租户授权；真实联调前由管理员准备，不要求发到聊天中。
- FrameFlow 对接收人可达的网页地址未指定；未配置时隐藏“打开网页”，不阻塞飞书内挑片；不自动开放公网。
- SDK 卡片表单/更新的具体类型组合、所需最小权限名、实际附件下载字节一致性必须用锁定版本和测试应用验证；这些验证失败要回到规格，不悄悄改为 Webhook 或删减交互。
- 本文提出的持久化/版本字段为下一阶段的设计约束，审批前不修改现有日志或 API。

**执行入口：[tasks/todo.md](tasks/todo.md) 已确认，按 [tasks/plan.md](tasks/plan.md) 小步实现；真实飞书验证仍需专用环境与发送许可。**
