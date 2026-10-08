---
labels: [wayfinder:map]
title: 照片整理 web 应用
status: open
---

# 照片整理 web 应用 · Wayfinder 地图

## Destination

一个开源、自托管的照片整理 web 应用：把磁盘上的一个目录**映射**成一个项目来浏览（不导入、不导出、不搬动），用「星级 + 待删」做快速且有趣的**标注**（含 Tinder 式滑动），待删进产品回收站；标注之后可以触发**任务**（导出、删除、将来的滤镜处理，以及把批注任务推送到飞书等外部渠道再回流）；**AI 可以参与选片** —— 既能作为执行者被我们调用，也能作为客户端自己来取活干。单用户，家中部署，Tailscale 网内任何设备可访问。

## Notes

- 定位：自用优先，但按可发布的开源产品标准做（部署要简单）
- 文件夹即真相：直接浏览/操作磁盘目录，不搞导入式媒体库
- **项目 = 映射进来的一个磁盘目录**：不导入、不导出、不搬动；原文件只会被写标记（XMP）与回收站操作碰到（[ADR 0003](../docs/adr/0003-project-is-a-mapped-directory.md)）
- 文件夹由用户自己先整理好：应用只做映射 → 扫描 → 标注（星级/待删）→ 回收站，不做任何归位决策
- **核心模型：库 + 标注 + 任务**（扫描/浏览/标注是状态层；删除/导出/处理/推送批注是动作层任务）——见 [docs/core-model.md](../docs/core-model.md) 与 [ADR 0004](../docs/adr/0004-jobs-and-events.md)
- 骨架纪律：先预演再执行 · 一切写磁盘的动作都是任务且有 manifest · 选择集是可序列化的谓词 · 要事件日志不要事件总线 · 要任务不要工作流引擎
- **后端 = TypeScript（Node）**：与前端同语言、共享契约类型；能力以「注册表 + manifest」装配（每能力一文件、只依赖 core、声明副作用等级），新增能力前端零改动（[ADR 0005](../docs/adr/0005-typescript-backend.md)）
- **AI 不是特殊通道，是最挑剔的客户端**：同一套 API、三种凭据（浏览器 cookie / Bearer token / 范围受限链接 token）；AI 可被我们调用（annotate 任务），也可自己来取活干（MCP/HTTP）（[core-model §11](../docs/core-model.md)）
- 外部模块（插件）与内置模块同一 manifest 契约；模块不能直接碰磁盘，只能经 core 的接口
- 拍摄格式：RAW + JPEG 双出，配对成对处理
- **库在 NAS 上（网络共享）**：缩略图与索引缓存在服务端本地（不写回共享）；扫描要增量（按 mtime+size 判脏）；回收站必须与被删文件同共享（`rename` 只在共享内原子）；跨共享的移动=复制+删，不能当原子操作
- 删除 = 逻辑删除（产品管理的回收站，可恢复）
- 交互要求：便捷、高效、有趣；触屏滑动 + 键盘流都要
- 用户现实目录习惯：项目目录（一次旅行/一次导入）→ 按设备分 → 照片|视频分 → 原始|修改后
- tracker：本地 markdown，约定见 [TRACKER.md](TRACKER.md)
- 会话开工先读 grilling / domain-modeling 技能；原型票用 prototype 技能；research 票由子代理调用 research 技能解决

## Decisions so far

- [RAW 预览与 RAW+JPEG 配对方案](tickets/001-raw-preview-pairing.md)：服务端分层预览管线（外部 JPEG 优先→内嵌提取→LibRaw 兑底）；同目录同名配对；pair 为一等实体，打星/待删/归档成对原子处理，星级写 XMP。详见 [研究报告](research/001-raw-preview-pairing.md)
- [挑选交互原型（星级+滑动）](tickets/002-culling-interaction-prototype.md)：一份数据两种焦距（卡片流 ⇄ 网格，变焦飞行切换）；右滑加星·下压连加·左滑待删，星与待删互斥；键盘 1–5/0/←→/X/空格/Ctrl+Z；双击放大 2.5× 带小地图；RAW+JPEG 始终成对。已演化为正式前端 `web/`
- [叠卡与滑动手势的可借鉴开源实现](tickets/006-swipe-stack-libs.md)：不整体换库，按 Swing 的物理参数模型升级手写叠卡（拖动耦合后排 + 速度参与的弹簧松手 + 交接曲线连续）；Swiper `effect:'cards'` 作为 B 计划。详见 [研究报告](research/006-swipe-stack-options.md)
- [产品骨架决策（已收窄：只剩「标注任务」骨架）](tickets/004-product-skeleton.md)：前五条（映射机制 / 回收站 / XMP 存储 / 访问控制 / 显示名）已在实现里落地；标注任务**复用 `/jobs`**（`kind: 'annotate'`：selection = 范围、manifest = 派发记录、events = 回流流水，通道只是投递方式）；外部批注人用**带 scope 的链接 token**（`annotate:<jobId>`，只读该任务选择集 + 缩略图、只写标注、可撤销、有有效期，回流记 `by: 'link:<批注人>'`）；回流**直接落** XMP + `marks.jsonl`（不做建议层），冲突后写覆盖 + 历史留痕，乐观并发以后再说
- [网络挂载挂死时的服务健壮性](tickets/011-hung-mount-robustness.md)：**只让出问题的根不可用，不让进程陪葬** —— 扫描路径全异步（XMP 读写、缓存探测）+ 每根 20s 超时（`scan.rootTimeoutMs`）+ 超时后 10 分钟冷却（手动 `POST /scan` 可强制重试）+ 启动 3s 探测；ffmpeg 抽封面全局并发 2、连败 3 次熔断 5 分钟；`GET /roots` 新增 `lastError`（前端显示「未连接 + 原因」）。回归 `server/tools/e2e-hung-mount.mjs`（18/0，用 `ARTWORKS_TEST_HANG_ROOT` 模拟挂死）
- [部署形态（已收窄：只剩跑在哪 + 交付方式 + 缓存/HTTPS）](tickets/005-stack-deployment.md)：服务以后**直接连 NAS**但保持「根 = 目录路径」的挂载无关设计（本地盘 / NFS / SMB / USB 同一套代码）；交付**两条路都提供、最终 docker compose**（镜像带 node+sharp+ffmpeg+exiftool）；预览缓存 = 本地磁盘缓存（默认上限 8 GB、可配、启动按 atime LRU 淘汰到 90%），索引不设过期 + 上次扫描超 7 天启动自动补扫；只在局域网 / Tailscale，不加反代与证书。落地拆成 [012](tickets/012-deployment-artifacts.md)、[013](tickets/013-cache-policy.md)
- [任务与外部批注的 API 形状](tickets/008-task-and-annotation-api.md)：`selection` 存谓词、`items[]` 存**创建时展开的快照**（粒度 = 照片配对组，`progress` 数 items）；v1 **不做**命名选择集（`POST /selections`）；回流端点为 **`POST /jobs/{id}/inbound`**（`/channels` 只出站，删掉 `/channels/{id}/inbound`），`by` 由 token 里的批注人推 `link:<批注人>`，幂等 = `clientRef`，冲突后写覆盖 + 历史留痕；身份 = 任务签发的**范围 token**（载荷 `annotate:<jobId>`，TTL 30 天、可撤销）；进度流 v1 = **增量轮询** `events?since=`（事件带单调递增 `seq`，将来可换 SSE）；`/trash` 保持同步、**不设** `kind:'trash'`。实现拆成 [014](tickets/014-jobs-core.md)（任务层核心）+ [015](tickets/015-annotate-dispatch.md)（批注派发与回流）
- [任务层核心](tickets/014-jobs-core.md)：**已落地（2026-10-07）** —— `dataDir/jobs.jsonl`（一行一快照、同 id 后写覆盖先写）+ `dataDir/job-events.jsonl`（只追加、`seq` 全局单调）双日志，启动重放；状态机 `planned→queued→running→done|failed|cancelled`（+`interrupted`），非法迁移 409，重启把 `queued|running` 收敛为 `interrupted`；`JobHandler` 注册表（一个 kind 一文件，未注册 → 400）；`mode:'plan'` 只展开 items、不落库不签 token；进程内单 pump（不做 SSE / 调度器 / worker 池）；items 是创建那一刻的快照。回归 `server/tools/e2e-jobs.mjs`（81/0）
- [批注派发与回流](tickets/015-annotate-dispatch.md)：**已落地（2026-10-07）** —— 第四种凭据「任务范围 token」（载荷 `annotate|<jobId>|<批注人>|<exp>|<tokenId>`，第 5 段绑签发它的 API token，30 天 HMAC、不落 `tokens.json`）只放行本任务 items 的缩略图与 `POST /jobs/{id}/inbound`（范围外一律不放行：没带凭据 401、越界 404、取消/撤销后 403；撤销签发 token 即失效，只读 linkToken 写回流 401）；回流 `by` 由批注人推 `link:<批注人>`、`channel` 取 `params.channel`、`clientRef` 幂等；全终态 → `done`；`undo` 按 `marks.jsonl` 里本任务最早的 `from` 回滚。v1 通道只做 `inapp`（链接进 artifacts，真投递另开票）；批注页/任务页界面拆到 [016](tickets/016-task-ui.md)。回归 `server/tools/e2e-annotate.mjs`（94/0）
- [任务页与批注页](tickets/016-task-ui.md)：**已落地（2026-10-08）** —— 任务页 = 左列表（按状态筛）+ 右详情（进度 / items 快照 / 产物链接 / 事件流水），数据只走 `GET /jobs`、`GET /jobs/{id}`、`GET /jobs/{id}/events?since=`（列表 4s、详情 2.5s 增量轮询，`nextSince` 当游标）；批注页 = `/j?t=` **整页独立**于 App 外壳、免登录（凭据只有 URL 里的范围 token，缩略图 `<img>` 也带 `?t=`），逐张标星级/待删、`clientRef` 幂等回流、发不出去可重发、刷新从 items 读回；入口在挑片页底部（直接复用 store 的 Selection + 绑项目，张数以服务端 `mode:'plan'` 预演为准，apply 异步所以盯 `GET /jobs/{id}` 直到链接出现）；手机先列表、宽屏才默认选中，批注页 390px 下触控目标 ≥44px。为此范围 token 新增放行 `GET /jobs/{id}`（只放行 token 里那一个 id）
- [部署交付物](tickets/012-deployment-artifacts.md)：**已落地（2026-10-08）** —— Docker 多阶段镜像（runtime = node:22-slim + ffmpeg/perl，Node 22 原生跑 .ts）+ compose（宿主 8791，`/config:ro`+`/data`+`/photos` 三卷，uid 1000 说明）+ 裸机 `deploy/install.sh`（npm ci → 前端构建 → 生成本机配置 → 用户级 systemd 单元）+ `deploy/artworks.service` 模板；README 部署节（含 Tailscale / dataDir 备份 / 升级）。验证：裸机等价路径（Node 22 直跑 + 容器风格路径 + 测试库副本）全绿；`docker compose build/up` 待用户解锁 docker socket（Omarchy 默认不给，票里记了三条解锁命令）
- [预览缓存策略](tickets/013-cache-policy.md)：**已落地（2026-10-08）** —— `cache.maxBytes`（默认 8 GiB，0 = 不限）管 512/2048 两档 + thumbs；超限按 atime LRU 删到 90% 停（读命中时旧过 1h 才刷 atime，适配 relatime）；起监听后后台跑、单轮 ≤2000 文件、在途与视频封面受保护、半截 .tmp 1h 清；`scan.autoRescanAfterDays`（默认 7，0 = 关）= 启动扫描即补扫 + 长期实例每 10 分钟检查（**不**跳过启动扫描，保冷启动语义）；可观测走 `/capabilities.library.cache` / `.autoRescan`。顺手把 `~` 前缀展开进配置路径。回归 `server/tools/e2e-cache.mjs`（35/0）
- [AI 接入面](tickets/009-ai-access.md)：**已拍板并落地 pull 形态（2026-10-08）** —— 五问全定：先 pull 后 push；**直接落标不做建议层**（`by: 'ai:<token label>'` Bearer 自动打标，`sel=by:ai` 复核，回滚靠 `marks.jsonl`）；**MCP 不进 v1**（REST + Bearer + 自认证缩略图 + `/capabilities` + `docs/agent-access.md` 接入指南即够，MCP 待第二消费者再作薄包装）；**Bearer v1 全权限**（scope 字段已存未强制，只读缩略图走 linkToken，真删磁盘仍须人工）；**不做 claim/lease**（无状态循环 + 后写覆盖留痕，确定性用任务层）。`/capabilities.executors` 补 `status:'planned'` 如实标注占位
- [插件扩展面](tickets/010-plugins.md)：**已拍板（2026-10-08，v1 零代码）** —— 内置与第三方同一套 manifest 契约、v1 只加载内置；冻结贡献点只有 `JobHandler` 与 `Channel`（已是注册表 → `/capabilities` 投影）；副作用五档（只读/写标注/写库内状态/写新位置/写原片目录）进 manifest 形状、v1 不做运行时强制；虚拟目录 = 默认关闭插件、结构存应用数据目录、导出真实目录另行立项；启动扫描 + 重启生效、in-process 隔离；v1 不冻结对外插件 API（宣布开源时再冻结）


## Not yet specified

- 手机端布局与触控细节（等交互原型拿到反馈）
- 视频播放与转码边界：**缩略图已定** —— 服务端 ffmpeg 抽一帧当封面（`preview: video_poster`，缓存在本机缩略图缓存，不写回共享），播放交给浏览器原生；仍未定：播放器控件、以及浏览器原生播不了的格式要不要服务端转码
- 性能指标量化（单项目千张级？万张库的首屏与滚动）
- 「偏软 / 跑焦」角标的值从哪来（现在前端拿的是假数据）：靠 EXIF、靠服务端图像分析，还是干脆删掉这个概念
- 导出：把挑好的照片交到别的目录 / 别的工具（用户 m01572「后续再做」）——形态未定（复制？链接？给外部工具一个清单？）；已按任务层设计占位（[docs/core-model.md](../docs/core-model.md) §8）
- 滤镜 / 处理：作为导出任务的 recipe 参数，而不是独立管线（现在不做）
- 开源发布配套：License 选择（注意 AGPL 项目如 Immich/PhotoPrism 的代码传染性）、README、一键部署
- AI 接入面的具体形态：先做 pull 还是 push、结果是否走「建议」层、MCP 是否必做、token 范围、领取机制 → [票 009](tickets/009-ai-access.md)
- 插件扩展面：内置模块与第三方插件的分界、插件能贡献什么、权限等级、加载与隔离 → [票 010](tickets/010-plugins.md)；其中「虚拟目录 / Alcedo 式项目节点路径」是**默认关闭的可选插件**
## Out of scope

- 素材导入（LR 式工作流）—— 用户判定多余：照片已经在磁盘上按项目分好了目录，导入要多一份与来源对账的状态（「导入后删来源」还引入不可逆的破坏性动作）。理由见 [ADR 0003](../docs/adr/0003-project-is-a-mapped-directory.md)；导出不在这里（推迟到后续，见 Not yet specified）
- 归档 / 规则引擎（条件匹配 → 目标目录模板 → 先预演再原子移动）—— 用户判定不需要（m01565 问「归档是什么，是不是可以简化掉」→ m01572「文件夹我可以先整理好」）：文件夹自己先整理，应用只标注与删除。曾经实现到可演示，已整体删除；规范草稿与语义留在 [contracts/rules.md](../contracts/rules.md) 与 [ADR 0002](../docs/adr/0002-archive-rule-semantics.md)（已标为取代）；将来要做导出/归位时重开一张新图
- 预设滤镜（视觉调色/导出滤镜）——用户明确「先不做」；将来想要时重开一张新图
- 多用户、客户分享选片
