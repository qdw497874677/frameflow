# 核心模型：库 + 标注 + 任务

> 回答三个问题：①「扫描 / 标记 / 处理 / 导出 / 删除」这个拆法对不对？②要不要引入工作流与事件驱动？③每个功能怎么模块化？
> 结论先说：**拆法方向对，但五个动词不并级**；**要事件，不要事件总线；要任务，不要工作流引擎**；模块化落在三个边界上（进程 / 端口 / handler）。

状态：设计稿（2026-09，随用户 m01633 / m01709 / m01715 提出）。对应决策记录见 [ADR 0004](adr/0004-jobs-and-events.md)。

---

## 1. 五个动词不并级

把「扫描、浏览、标记、处理、导出、删除」平铺成六个平级功能，是最容易走偏的地方。它们其实是**两层**：

| 层 | 动词 | 特征 | 失败代价 |
|---|---|---|---|
| **状态层**（库 + 标注） | 扫描、浏览、**标记** | 同步、廉价、可反复；改的是索引与标注（XMP） | 低：重扫一次就回来了 |
| **动作层**（任务） | 处理、导出、删除、推送批注 | 异步、有产物、要进度/日志/撤销；会碰磁盘或外部系统 | 高：删错、导错、外部已读 |

两层的差别不是「快慢」，而是**有没有产物、能不能撤销、要不要对账**。凡是「要告诉用户我干了什么、干成了没有、怎么撤」的，都是动作层的任务；凡是「改完即时生效、不需要解释」的，都是状态层。

**这一点决定了整个架构**：不需要给每个功能都设计一套流程，只需要把动作层统一成一种东西 —— 任务（Job）；状态层保持简单同步。

> 顺带说：之前砍掉的归档里，最有价值的不是规则 DSL，而是「**先预演、再执行**」这条纪律。它没有跟着归档死掉，而是升级成了**所有任务的通用契约**（见 §5）。

## 2. 五个概念

```
库 Library ── 标注 Mark ──▶ 选择集 Selection ──▶ 任务 Job ──▶ 产物 / 变更 / 待批注任务
   ▲                                                                     │
   └────────────────── 回流：外部批注 → 标注 ◀───────────────────────────┘
```

1. **库 (Library)** — 根目录 / 项目（映射的目录）/ 照片与组（RAW+JPEG+影子文件）。扫描建立**索引**（缓存，可重建）；磁盘永远是真相。
2. **标注 (Mark)** — 一条照片（组）身上的态度：`stars`(0–5) 与 `del`(待删)。落 XMP，与 Lightroom / digiKam 互通。**每条变更带来源**：谁、什么时候、通过哪个渠道、从什么变成什么。
3. **选择集 (Selection)** — 一个**可序列化的谓词**（`{项目, 星级 ≥ 3, 不含待删, 只要照片}`），不是一串 id。执行时求值成照片清单；UI 里的「当前筛选」就是它的投影。这样任务可重放、可定时、可在别的设备上重新求值。
4. **任务 (Job)** — `{kind, selection, params, state, progress, manifest, artifacts, log}`。动作层唯一的实体：删除、导出、处理、推送批注……**都是任务**，差别只在 kind 与产物落到哪里。
5. **通道 (Channel)** — 任务的派发与回流面：`inapp`（默认，SSE 进度）、`feishu`、`http-client`（外部客户端 / CLI）。通道只搬任务与结果，**不含业务语义**。

## 3. 不变量（破一条，后面全烂）

1. **原片只被三类操作碰到**：写 XMP 标记、移入/移出回收站、显式确认的真删。**处理与导出只写新位置，绝不覆盖原片。**
2. **一切写磁盘的动作都是任务**，都有 manifest（碰过 / 产出了哪些文件）。没有「隐形」的写，否则无法对账与撤销。
3. **任务必先预演（plan）再执行**；预演只读、可丢弃。
4. **选择集存谓词，不存 id 清单**（显式手选除外）。id 清单不可重放。
5. **标注是唯一会跨端合并的状态**：每次变更带 `(by, at, channel, from→to)`；冲突是「后写覆盖 + 保留历史」，绝不静默丢。
6. **派生的一切可重建**：缩略图、预览缓存、索引、产物登记表，删掉重扫即可。**但事件日志不可重建**（它记的是「谁在什么时候改的」，XMP 只留最终状态）。
7. **任务幂等**：同 `idempotencyKey` 重放不重复搬 / 删；因为它们会被推到网络另一头并重试。

## 4. 事件驱动：要事件日志，不要事件总线

**要**：
- **领域事件日志**（追加写）：`MarkChanged`、`JobChanged`、`PhotoTrashed`。用途：外部批注回流要合并、要审计、要「我上周标了什么」、要在手机上看到进度。
- **进度流**：任务状态变化经 SSE 推给前端（`GET /jobs/{id}/events`）。一个进程内事件表 + 一个 SSE 端点，够了。

**不要**（现在）：
- 消息队列 / 事件总线（Kafka、Redis Streams、RabbitMQ）：单用户、单进程、没有多消费者，引入它只会换来「消息丢了怎么办 / 顺序怎么保证」的新问题。
- 事件溯源的完整玩法（用事件重放整个状态）：XMP 已经是状态的真相，事件只承担 provenance。
- 内部模块之间用事件解耦：同一进程里的事件是**通知**，不是调用约定；模块之间直接函数调用 + 明确的返回类型更好读。

升级条件（出现才做）：多个 worker 并行执行任务、或真要推送量级的外部回调。

## 5. 工作流：要任务，不要工作流引擎

**不引入通用工作流引擎**（DAG 编辑器、状态机 DSL、重试/补偿策略框架、可视化编排）。理由：引擎服务的是**机器编排的**多步流程；我们这里的「多步」要么由人推着走（扫 → 挑 → 导出），要么是单个长任务的内部循环。引入引擎会把最该保持清晰的「预演 → 执行 → 记账」纪律淹没在引擎的抽象里。

要的是**一个小而硬的契约**，每个能力实现它：

```ts
interface JobHandler<P> {
  kind: JobKind;                                   // 'trash' | 'export' | 'annotate' | …
  validate(input: { selection: Selection; params: P }, lib: Library): Promise<Problem[]>;
  plan(input: { selection: Selection; params: P }, lib: Library): Promise<Plan>;   // 只读预演
  apply(plan: Plan, sink: JobSink): Promise<Outcome>;                              // 幂等执行
  undo?(outcome: Outcome, lib: Library): Promise<void>;                            // 能力支持才实现
}
```

- **新增能力 = 新增一个 `kind` + 一个 handler 文件**，前端不动（任务页按 kind 渲染 manifest 与 artifacts）。
- 任务状态机是**线性**的：`planned → queued → running → (done | failed | cancelled)`，失败可重试，不做分支跳转。
- 真要「导出 → 自动推飞书 → 等回执」这种串联：**两个任务 + 一条 onDone 规则**（`job:export 完成后创建 job:annotate`），不是一张 DAG 图。串联规则先写死在配置里，不写成可视化编排。

## 6. 模块化：三个边界

| 边界 | 规则 | 现状 |
|---|---|---|
| **进程** | 只有后端碰磁盘；前端纯客户端 | ✅ 已有（`web/` + `server/`） |
| **端口** | UI 只认 `PhotoSource`（即将拆成 `LibrarySource` + `JobSource`），mock / http 两个实现行为一致 | ✅ 已有，待拆 |
| **能力** | 后端每个能力 = 一个 handler（`jobs/*.ts`），只依赖 `core/` 的接口，**handler 之间不互相 import**；通道同理（`channels/*.ts`）；模块由注册表装配并导出 manifest（kind、参数 schema、副作用等级），能力经 `GET /capabilities` 自描述 | ⬜ 待建（语言与装配方式已定：[ADR 0005](adr/0005-typescript-backend.md)） |

```
server/
  core/       library(扫描·配对·身份)  marks(标注+变更日志)  selection(谓词求值)
              job(登记·状态·事件)      policy(谁能做什么)
  jobs/       trash.ts   export.ts   annotate.ts        ← 每个能力一个文件，导出 JobHandler
  channels/   inapp.ts   feishu.ts   http.ts            ← 派发与回流
  storage/    index(缓存)  marks.jsonl  jobs.jsonl  artifacts  xmp
  api/        httpapi(路由·编解码)  sse(进度流)          ← 不含业务逻辑
```

`web/` 侧对应：`features/<页面>/` 一页一目录；`api/` 是端口；跨页共享的东西（store、类型、UI 组件）在 `core/`、`components/`。

## 7. API 形状（接口即边界）

现在（已实现）：`/health` `/session` `/roots` `/folders` `/photos` `/photos/{id}/thumb|file` `/marks` `/marks/history` `/trash` `/trash/restore` `/jobs*` `/channels`（任务层 2026-10-07 落地；handler 接缝与「加一个 kind」的步骤见 `server/README.md`）。

任务层（已实现，形状先由契约定）：

```
POST /jobs                       { kind, selection, params, idempotencyKey? }（创建时把 selection 展开成 items 快照）
GET  /jobs?state=&kind=&project=
GET  /jobs/{id}                  状态 + 进度 + manifest + artifacts
GET  /jobs/{id}/events           增量事件日志（?since= 轮询，seq 游标；将来可换 SSE）
POST /jobs/{id}/cancel
POST /jobs/{id}/undo             handler 实现了 undo 才可用
GET  /channels                   有哪些出站派发目标
POST /jobs/{id}/inbound          外部批注回流口（IM 回调 / 外部客户端；by 由 token 里的批注人推）
GET  /marks/history              标注变更流（按照片 / 时间 / 任务）
POST /selections                 可选：保存命名选择集（v1 不做 —— 快照由任务的 items 解决）
```

`/trash` 系列**保留为同步便捷入口**（不是 `kind:'trash'` 任务）：同步、单工作单位、没有进度的事不异步化，点一下就该看到结果。

## 8. 扩展配方（验证抽象够不够）

| 想加的能力 | 怎么加 | 前端改动 |
|---|---|---|
| **导出**（挑好的照片交到别处） | `jobs/export.ts`：`plan` 展开目标路径 + 冲突处理，`apply` 复制 + 写 manifest，`params.recipe` | 任务页 + 一个「导出」入口 |
| **风格 / 处理** | 风格（Look）由风格类型（LookKind）承载，配方 `{ lookId, kind, params }`，参数按类型自带的模式（[ADR 0006](adr/0006-look-and-look-kind.md)）；新类型 = 注册一个 LookKind，不是新管线 | 无（面板按模式自动生成） |
| **推送到飞书批注** | `jobs/annotate.ts` + `channels/feishu.ts`：推送选择集为卡片（先展开 `items` 快照），回执经 `POST /jobs/{id}/inbound` 写成标注（`by: 'link:<批注人>'`） | 任务页显示「待外部批注」 |
| **AI 自动挑选** | 一个 `annotate` 任务的执行者（产出标注，`by: 'ai'`），不是新架构 | 无 |
| **定时任务**（每周导出四星） | `selection` + `schedule` 两个字段，加一个 cron 触发；**调度器最后做** | 无 |

## 9. 现在只做三件小事（已落地 —— 把门留开，不提前盖楼）

1. **标注带来源与时间**：`MarkInput` 带 `at/by/channel`，后端每个**实际变化**的字段追加一条 `MarkChange` 到 `marks.jsonl`（XMP 仍是当前状态的真相）。前端已实现：mock 的变更日志与 `GET /marks/history` 已可读，设置页显示最近 10 条。
2. **筛选升级为 `Selection`**：store 里从零散 `filter` 字段变成可序列化对象，并且能在 URL 里表达（`?sel=stars>=3`）。规范：`contracts/selection.md`；实现：`web/src/core/selection.ts`（`matchesSelection` 是后端的参考实现）。
3. **契约预留任务层**：`contracts/openapi.yaml` 写下 `/jobs`、`/channels` 的形状（`x-implemented: false`），`server/README.md` 记下 JobHandler 接缝。**已落地（2026-10-07）**：`server/src/core/jobs.ts`（JSONL 双日志 + 状态机）+ `server/src/jobs/*`（registry/service/annotate/channels），契约全部 `x-implemented: true`，回归 `node tools/e2e-jobs.mjs`（81/0）与 `node tools/e2e-annotate.mjs`（76/0）。

**明确不做**（省下的都是复杂度）：工作流引擎 / DAG、消息队列 / 事件总线、插件市场、账号与权限体系（RBAC）、cron 调度器、通用风格 DSL、把现在同步的动作异步化。

## 10. 四件待拍板的事（已拍 —— 2026-09，用户确认「按这个做」）

1. **标注要不要记「谁 / 什么时候」** → **要**，且最早加（成本极小，晚加要迁移历史）。
2. **任务要不要持久化** → **最小持久化**（状态表 / JSONL），重启后历史可查；但**执行队列不持久化**，重启时把 `running` 标为 `interrupted` 让人重跑，别做断点续传。
3. **外部批注人的身份** → **v1 不做账号体系**。一个任务签发一个**带权限范围的链接 token**（只读这一批 + 只能写标注），回填 `by: 'link:<批注人>'`。
4. **第一个落地的异步能力** → **导出**。它最安全（只写新位置，不碰原片）；飞书推送等 004（状态存哪 / 访问控制）与 005（技术栈）定了再做。**实际先落的是 `annotate`（推送批注，2026-10-07）**：004/008 定了任务骨架与范围 token 后，用户要求先把「推一批给人批注」跑通；导出仍是下一个 kind。

## 11. AI 接入面：AI 是最挑剔的客户端，不是特殊通道

用户把 AI 参与选片列为急需（m01899），并要求「提供 ai 可用的 api 来让 ai 介入选片工作流」。
AI 有两条进入路径，**两者都落在已有概念上，不新增架构**：

**A. AI 作为执行者（push）** —— 我们创建 `annotate` 任务，handler 去调模型：

```jsonc
POST /jobs { kind: 'annotate', selection: { where: { marked: false } }, params: {
  executor: { kind: 'openai' | 'anthropic' | 'ark' | 'ollama', model, baseUrl? },
  criteria: '按构图与表情挑出最好的 3 张，其余记 0 星',
  apply: false          // false = 只出建议，不写标注
}}
```

输入图像取自 `GET /photos/{id}/thumb?size=2048`（历史决策 001 的分层预览管线正好是它的输入源），产出的标注记 `by: 'ai:<model>'`。

**B. AI 作为客户端（pull）** —— 外部 agent（Claude / GPT / 本地脚本，甚至另一个 pi 会话）自己来取活干：
**这是「AI 介入选片工作流」的默认形态** —— 我们的进程不存模型 key、不花钱、换模型只换客户端。

```
MCP 工具（同一 API 的薄适配器）：list_photos / get_photo / set_marks / create_job / job_status
或直接 HTTP：GET /photos?sel=… → 取 2048 缩略图 → PUT /marks（带 by: 'ai:claude'）
```

两种形态需要的机制**都已在不变量里**：幂等键（7）、`by/at/channel` provenance（5）、任务可被外部领取（见历史决策 009）、`GET /capabilities` 自描述、三种凭据的认证面（ADR 0005）。

**建议层还是直接落定**：AI 直接写标注，靠 `by` 区分来源；UI 按来源显示（「AI 建议 ★★★」），选择集加 `by:` 词即可一键过滤/清空。
**不引入独立的「提案」实体** —— 省一张表；回滚依据是 `marks.jsonl`。

**pull 形态的两个实现要点**（用户 m01948 定「先做让 agent 调用」）：

1. **签发长期 Bearer token**：`POST /api-tokens`（列出 / 签发 / 撤销），明文只在签发响应里出现一次，服务端存哈希 + `label/lastUsedAt/scope`；agent 用 `Authorization: Bearer …` 调 API。
2. **缩略图 URL 必须自认证**：`GET /photos/{id}/thumb?size=2048&t=<linkToken>`。原因很实在 —— agent 是把 URL 交给自己的图像加载器（甚至模型服务商）去取的，**带不上自定义 header**；URL 里必须自带凭据。
   已实现：签发 API token（`POST /api-tokens`）时响应里一并给出 `linkToken` 与 `thumbUrlTemplate`（把 `{id}` / `{size}` 填上即可）。签名载荷是 `link|<tokenId>|<exp>`（30 天）——绑的是**签发它的那条 API token**，不是单张照片，所以一个 linkToken 能取全库缩略图；撤销 API token 立刻失效。范围只有 `/thumb`：`?t=` 只在缩略图路由上被消费，写接口仍然只认 cookie / Bearer。
范围受限的外部批注链接（`by: link:<批注人>`）**已落地（2026-10-07，历史决策 008/015）**：载荷 `annotate|<jobId>|<批注人>|<exp>|<tokenId>`（30 天，HMAC 签名、不落 `tokens.json`；第 5 段绑签发它的 API token，`-` = 会话/免认证签发），只放行本任务 items 的缩略图、`GET /jobs/{id}`（**只读 token 里那一个任务**：批注页刷新后靠它读回已经标过的 items）与 `POST /jobs/{id}/inbound`，撤销签发它的 API token 即失效；缩略图用的 `linkToken` 是只读凭据，拿去写回流一律 401。

**权限边界**：AI 客户端默认可做状态层（读 + 写标注）与只写新位置的任务；**真删磁盘文件仍必须人工确认**（不变量 1 已保证——那是唯一删盘入口）。

已拍板（2026-10-08，历史决策 009 的全部五问，原记录可查 Git 历史）：①先 pull 后 push；②直接落标不做建议层（`by: 'ai:<model>'` + `sel=by:ai`，回滚靠 `marks.jsonl`）；③MCP 不进 v1（REST + Bearer + 自认证缩略图 + `/capabilities` + [agent 接入指南](agent-access.md) 即够，MCP 待第二消费者出现再作薄包装）；④Bearer v1 全权限（`scope` 字段已存未强制），只读缩略图走 linkToken，真删磁盘仍须人工；⑤不做 claim/lease（无状态循环 + 后写覆盖留痕；确定性用任务层）。

## 12. 插件扩展面：内置能力与第三方模块同一套契约

内置（`jobs/*.ts`、`channels/*.ts`，随代码发布）与第三方插件（从数据目录加载）**共用同一个 manifest 契约**，差别只在加载位置与生命周期。

| 贡献点 | 契约 | 例子 | 进 v1？ |
|---|---|---|---|
| 任务能力 | `JobHandler` | 导出、处理、annotate | ✅ 内置 |
| 通道 | `Channel` | 飞书、webhook、MCP | ✅ 内置（先只有 inapp） |
| AI 执行者 | `Executor` | openai-compatible / ollama | 随 annotate |
| **虚拟目录提供者** | `FolderProvider` | 应用内合集 / 节点层级（Alcedo 式项目路径） | 留缝 |
| 选择集新词 | `SelectionTerm` | `collection:` | 留缝 |
| 设置页片段 | 声明式表单 | 插件的配置项 | 留缝 |

**规则**：模块**不能直接碰磁盘**，只能经 `core/` 提供的接口（读索引、写标注、建任务）；manifest 里声明**副作用等级**
（只读 / 写标注 / 写库内状态 / 写新位置 / 写原片目录），宿主按等级拒绝越权 —— 不变量 1 与 3 因此对插件同样成立。

**虚拟目录（Alcedo 式的项目节点路径）**：这是唯一与「文件夹即真相」有张力的能力，所以它被设计成**非破坏性覆盖层**：
磁盘不动，应用内多一棵虚拟树（合集 / 精选 / 待打印），节点指向照片 id。因此 —— **默认关闭、可选启用**；
其结构属于**不可重建**的那一类（与 XMP、事件日志同级），存应用数据目录的项目文件（照片目录可写时也可写 `.artworks/`）。
把它做成插件而不是核心，是为了让「不来这套的人」完全看不到它。

已拍板（2026-10-08，历史决策 010 的全部六问，原记录可查 Git 历史）：内置与第三方**同一套 manifest 契约**，v1 只加载内置（代码内注册表）；冻结的贡献点只有 `JobHandler` 与 `Channel`，`FolderProvider` / `SelectionTerm` / 设置页留缝不冻结；副作用五档进 manifest 形状、v1 不做运行时强制；虚拟目录 = 默认关闭插件、结构存应用数据目录（照片目录只出 .xmp 与 .trash 不变）；加载 = 启动扫描 + 重启生效；v1 不冻结对外插件 API，宣布开源时再冻结。
