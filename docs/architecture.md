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

## 备份与启动体检

- `domain/maintenance/data-files.ts`：json / jsonl / 临时文件的体检规则（纯函数）。
- `application/maintenance/check-data-dir.ts`：体检用例，经 `DataDirReader` 端口读数据目录。
- `adapters/outbound/fs/data-dir.ts`：端口实现 + `backupDataDir`（复制数据目录并写 sha256 manifest，跳过 thumbs / previews 与 *.tmp）。
- `adapters/inbound/cli/backup.ts`：`npm run backup -- <目标目录>`。
- 启动时在 `index.ts` 跑一次体检，只记日志不阻断。

## 日志压缩

- `domain/maintenance/compaction.ts`：阈值规则（行数 ≥ 1000 且 ≥ 有效状态 2 倍）。
- `adapters/feishu/jsonl.ts` 的 `compact`：临时文件 → fsync → rename → fsync 目录，崩溃安全；损坏日志拒绝压缩。
- 只压缩"最后状态即全部语义"的日志：飞书 `cursors.jsonl`（每个 job×target 一行）与 `sessions.jsonl`（message 行折叠，revoke 保留）。加载后与每次追加后按阈值触发。
- `marks.jsonl` / `jobs.jsonl` / `deliveries.jsonl` / `actions.jsonl` 是审计与幂等依据（历史、opId 去重、投递结果），压缩会改变行为，故不压缩。

## 契约守卫

`tools/openapi-routes.test.mjs` 在临时目录起真实 `buildServer`，把 `printRoutes` 的 /api/v1 路由与 `contracts/openapi.yaml` 的 (方法, 路径) 双向比对（参数名与 HEAD 不计）。新增或删除路由必须同步契约。

## 实时入库（ingest）模块

有边界的子模块：照片「刚落盘」→ 库里出现，不必全量重扫。

- `domain/ingest/arrival.ts`：到达（IngestedFile）、半成品名过滤、写入稳定判定（StabilityPolicy）、RAW+JPEG 配对窗口（PairingWindow）、收件目录模板。
- `application/ingest/`：`IngestService` 编排「报到 → 稳定 → 配对 → 目录增量入库 → 库事件」；端口 `IngestSource` / `IngestCatalog` / `FileProbe` / `IngestClock`。
- `application/library/events.ts`：库事件环形日志（seq），`GET /library/events`（SSE）对外。
- `adapters/ingest/`：来源适配器（目录监听；FTP 见后续），**只经 `adapters/ingest/index.ts` 对外**；模块只依赖共享内核（`domain/exts.ts`、库事件、配置类型）—— `tools/architecture.test.mjs` 守着。
- 照片库实现 `Library.ingestDir()` 是 `IngestCatalog` 的实现：只重扫一个目录（配对只看同目录，结果与全量一致），期间占住扫描闸。

## 胶片模拟（film）模块

有边界的子模块：自研光谱胶片引擎（`engine/`，C++20，独立进程）把「负片 + 相纸 + 参数」烘焙成 3D LUT，服务端把它当作普通风格（look）用，导出仍走既有 Effect 管线。**功能开关缺省关**（`film.enabled: true` 或 `ARTWORKS_FILM_ENABLED=1` 才开）；关着时行为与以前完全一致。

- `domain/grading/film.ts`：胶片/参数类型、参数范围校验（与引擎同一套）、风格 id（`film` 前缀，避免与 .cube 风格撞名）、缓存键（引擎版本 + 胶片 + 相纸 + 尺寸 + 排序后的参数）、f32 载荷 → LUT。
- `application/grading/ports.ts`：端口 `FilmEngine`（stocks / bakeLut / version / health）、`FilmLutStore`（LUT 与胶片目录的持久缓存）。
- `application/grading/film-looks.ts`：`FilmLookSource` —— 内存 → 磁盘缓存（按版本键）→ 引擎烘焙 → 引擎挂了退回 `latest` 旧缓存；同一风格并发只烘焙一次。`composite-looks.ts` 把 cube 与 film 两个来源合成一个风格目录。
- `adapters/film/`：`ProcessFilmEngine`（懒启动 + hello 握手校验协议版本、串行队列、请求超时 SIGKILL 后下次自动重启、连续崩溃熔断冷却）、`FFE1` 帧编解码、`DirFilmLutStore`（`<dataDir>/cache/film-luts/`，tmp + rename 原子写）。**只经 `adapters/film/index.ts` 对外**，`tools/architecture.test.mjs` 守着。
- 路由：`GET /looks` 条目带 `kind`（cube / film）；film 风格的 `.cube` 引擎不可用且无缓存时回 503；`GET /film/status` 报引擎状态。
- 为什么独立进程：引擎崩溃/卡死不拖垮 Node；协议简单（长度前缀 JSON + 二进制载荷），可替换实现。
- 镜像：Dockerfile **暂不打包引擎与胶片数据** —— Kodak 数据表条款禁止再分发（见 `engine/PROVENANCE.md`），需要用户在部署机上自行运行 `engine/tools/fetch_stocks.sh` 生成数据并以 `ARTWORKS_FILM_BINARY` / `ARTWORKS_FILM_STOCKS` 指过去。
- 测试：`tools/film-engine.test.mjs` 用 `tools/fake-film-engine.mjs` 覆盖握手、超时、崩溃熔断、缓存降级、开关；设置 `FFE_ENGINE_BINARY` / `FFE_ENGINE_STOCKS` 时另跑真引擎用例（CI engine 作业里跑）。
