# ADR 0005：后端用 TypeScript，能力以模块注册

状态：**已接受**（2026-09，用户 m01889「可以 用ts 一些功能要支持后续通过模块化的方式集成」）
相关：[核心模型](../core-model.md) · [server/README.md](../../server/README.md) · 历史决策 005「技术栈与部署」（原记录可查 Git 历史） · [ADR 0004](0004-jobs-and-events.md)

## 背景

后端语言此前一直悬着（历史决策 005）。约束是攒出来的，不是猜的：

- **能力清单**：EXIF 与内嵌 JPEG 预览提取、写共享 XMP、文件移动与回收站、两档 JPEG 缩略图缓存、SSE 进度流、单进程唯一碰盘、单用户认证、家里部署 + Tailscale
- **后续要加**（用户明确）：**AI 参与选片（急需）**、导出与滤镜（作为导出 recipe）、把批注任务推到飞书等外部渠道
- **用户要求**：「一些功能要支持后续通过模块化的方式集成」（m01889）；「也要能够提供 ai 可用的 api 来让 ai 介入选片工作流」（m01899）；「把项目的节点配置路径相关功能通过插件模块化方式集成进来」（m01909）

参考项目 [Alcedo Studio](https://github.com/zidage/AlcedoStudio)（GPL-3.0；C++ 17.2MB / QML 1.9MB / Rust / CUDA / Metal；桌面 GPU 原生应用；库存在照片旁的 DuckDB，单一 `.alcd` 项目文件）：它的栈是为**实时调色**服务的，我们不需要。可借鉴两点 —— 「AI 作为可替换的外部服务」与「评分写回照片、别的软件能读」（后者我们已经定为写 XMP）。**不抄它的代码**（GPL 传染）。

## 决定

1. **后端语言 = TypeScript（Node 22 LTS+）**，与前端同语言；`contracts/openapi.yaml` 为唯一线格式来源（可生成类型，消灭手工 DTO 漂移 —— 我们已经修过一次 `TrashEntry` 漂移）。
2. **图像与文件层用现成库**：`sharp`（libvips：缩略图两档、内嵌 JPEG、ICC/旋转、导出 resize）、`exiftool-vendored`（EXIF 与内嵌预览提取）、`fast-xml-parser`（XMP 读写）、`node:worker_threads`（CPU 密集批处理不堵事件循环）。
3. **模块化 = 注册表 + 声明式 manifest**：`server/src/jobs/<kind>.ts` 每能力一个文件，导出 `JobHandler` 与 `manifest`（kind、参数 schema、**副作用等级**、是否需要网络/模型）；`server/src/channels/<kind>.ts` 每通道一个文件；由 `jobs/registry.ts`、`channels/registry.ts` 装配。**模块只 import `core/`，模块之间不互相 import。**
4. **能力自描述**：`GET /capabilities` 返回注册表投影（有哪些 kind、各自要什么参数、会碰什么）。前端与 AI 客户端都靠它发现能力 —— 新增能力 = 新增一个文件，**前端零改动**。
5. **AI 接入面**（详见 [core-model §11](../core-model.md)）：同一套 API、三种凭据 —— 浏览器会话 cookie、**Bearer API token**（AI agent / CLI / MCP）、范围受限**链接 token**（外部批注者）。**不为 AI 另开语义。**
6. **插件与内置同一契约**（详见 [core-model §12](../core-model.md)）：第三方模块从数据目录加载，能贡献的东西受 manifest 声明约束；**模块不能直接碰磁盘**，只能经 `core/` 的接口。
7. **逃生门**：真需要本地模型/GPU/高级 RAW 解码时，起一个 **sidecar 进程**（Python / Rust / 任何语言），按 JSON-over-stdio 的协议接入 —— 主体不重写。

## 备选与不选的理由

| 备选 | 好处 | 为什么不选（现在） |
|---|---|---|
| Go | 静态单二进制、部署最省心、内存占用低 | 同一份 DTO 要写两遍（前端已是 TS）；图像生态最弱，缩略图/RAW/滤镜全靠 cgo 或外部 CLI |
| Python/FastAPI | 图像与 AI 生态最强（rawpy/Pillow/ONNX/CLIP），与 Alcedo 的 AI 路线最贴 | 类型共享与部署（venv/uv）吃亏；v1 的图像需求（JPEG 缩略图 + 内嵌预览提取）`sharp` 完全够 |
| Rust | 单二进制 + 性能 | 开发速度与 AI 生态都不如上面三个；单用户家用场景性能不是瓶颈 |

**会重看它们的触发条件**：① 本地模型推理成为主路径（→ Python sidecar，或主体换 Python）；② 需要单文件分发 / 嵌入式部署（→ Go / Rust）；③ 导出滤镜需要真正的色彩科学（→ Python `colour-science` sidecar）。

## 后果

- CPU 密集任务（缩略图批扫、导出批处理）必须走 worker，**从第一天就这样写**。
- 部署 = `node` 进程 + 依赖（Docker 镜像或 systemd 单元），比 Go 的单二进制多一层，但仍在「一条命令重启」的范围内。
- `sharp` 是原生模块（各平台预编译包），部署文档要写清。
- 契约漂移风险降到最低，但 `contracts/openapi.yaml` 仍需校验（`js-yaml` 解析 + 类型生成，接进 CI/提交前检查）。
