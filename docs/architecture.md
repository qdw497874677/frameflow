# 后端架构：六边形分层

`server/src` 只有三层加一个组装根：

| 目录 | 职责 | 允许依赖 |
|---|---|---|
| `domain/` | 纯模型与规则：照片、选择、标记、任务状态机、投递策略/台账/确认、连接器配置校验与授权 | 仅 `domain/`、`node:path` |
| `application/` | 用例与端口（`*/ports.ts`）：任务服务、投递执行/分发、确认服务、连接器运行时 | `domain/`、`application/`、`node:path`/`node:crypto`/`node:async_hooks` |
| `adapters/inbound/http/` | HTTP 入站：路由、鉴权、DTO | 任意内层与出站适配器 |
| `adapters/outbound/` | 出站实现：照片库与文件系统存储（`fs/`）、EXIF/XMP、缩略图、配置文件 | 任意内层 |
| `adapters/feishu/` | 飞书平台适配（SDK、渠道、交互卡片） | 任意内层 |
| `index.ts` | 组装根：读取配置、创建适配器并启动 | 全部 |

端口示例：`JobsRepository`（`JobsStore` 实现）、`ConfirmationLog` / `DeliveryLedger`、`ConnectorConfigSource`、`WriterLock`（`PidFileLock` 实现）。

## 守卫

`server/tools/architecture.test.mjs` 解析所有 `import`/`export ... from`，违反上表即失败；同时要求顶层只出现三层与 `index.ts`。


## 约定

- 领域层不读环境变量、不碰文件：需要的值（如 `SecretEnv`）由调用方传入。
- 新的持久化先在 `application/*/ports.ts` 定义接口，再在 `adapters/outbound` 实现。
- 行为变更与结构调整分开提交。

## 飞书模块

`adapters/feishu/index.ts` 是唯一入口：`loadFeishuSdk`（真实 / 离线假 SDK / 不注册）、`feishuConnector`（连接器工厂）、`openFeishuInteraction`（卡片交互控制器 + 任务入口卡传输）。模块外的源码只能 import 这个文件（架构守卫校验）；测试可以直接测内部文件。
