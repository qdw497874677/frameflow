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
| **能力** | 后端每个能力 = 一个 handler（`jobs/*.ts`），只依赖 `core/` 的接口，**handler 之间不互相 import**；通道同理（`channels/*.ts`） | ⬜ 待建 |

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

现在（已实现）：`/health` `/session` `/roots` `/folders` `/photos` `/photos/{id}/thumb|file` `/marks` `/trash` `/trash/restore`。

新增（任务层，先写进契约、后实现）：

```
POST /jobs                       { kind, selection, params, idempotencyKey? }
GET  /jobs?state=&kind=&project=
GET  /jobs/{id}                  状态 + 进度 + manifest + artifacts
GET  /jobs/{id}/events           SSE 进度流
POST /jobs/{id}/cancel
POST /jobs/{id}/undo             handler 实现了 undo 才可用
GET  /channels                   有哪些派发目标
POST /channels/{id}/inbound      外部批注回流口（IM 回调 / 外部客户端）
GET  /marks/history              标注变更流（按照片或时间）
POST /selections                 可选：保存命名选择集（v1 只存不导）
```

`/trash` 系列**保留为同步便捷入口**（等价于 `kind: 'trash'` 的即时任务）：小事不该被异步化，点一下就该看到结果。

## 8. 扩展配方（验证抽象够不够）

| 想加的能力 | 怎么加 | 前端改动 |
|---|---|---|
| **导出**（挑好的照片交到别处） | `jobs/export.ts`：`plan` 展开目标路径 + 冲突处理，`apply` 复制 + 写 manifest，`params.recipe` | 任务页 + 一个「导出」入口 |
| **滤镜 / 处理** | 就是 export 的 **recipe 参数**（`{filters: [...], resize: {...}, format}`），不是新管线 | 同上 |
| **推送到飞书批注** | `jobs/annotate.ts` + `channels/feishu.ts`：推送选择集为卡片，回执经 `/channels/feishu/inbound` 写成标注 | 任务页显示「待外部批注」 |
| **AI 自动挑选** | 一个 `annotate` 任务的执行者（产出标注，`by: 'ai'`），不是新架构 | 无 |
| **定时任务**（每周导出四星） | `selection` + `schedule` 两个字段，加一个 cron 触发；**调度器最后做** | 无 |

## 9. 现在只做三件小事（已落地 —— 把门留开，不提前盖楼）

1. **标注带来源与时间**：`MarkInput` 带 `at/by/channel`，后端每个**实际变化**的字段追加一条 `MarkChange` 到 `marks.jsonl`（XMP 仍是当前状态的真相）。前端已实现：mock 的变更日志与 `GET /marks/history` 已可读，设置页显示最近 10 条。
2. **筛选升级为 `Selection`**：store 里从零散 `filter` 字段变成可序列化对象，并且能在 URL 里表达（`?sel=stars>=3`）。规范：`contracts/selection.md`；实现：`web/src/core/selection.ts`（`matchesSelection` 是后端的参考实现）。
3. **契约预留任务层**：`contracts/openapi.yaml` 写下 `/jobs`、`/channels` 的形状（`x-implemented: false`），`server/README.md` 记下 JobHandler 接缝。

**明确不做**（省下的都是复杂度）：工作流引擎 / DAG、消息队列 / 事件总线、插件市场、账号与权限体系（RBAC）、cron 调度器、通用滤镜 DSL、把现在同步的动作异步化。

## 10. 四件待拍板的事（已拍 —— 2026-09，用户确认「按这个做」）

1. **标注要不要记「谁 / 什么时候」** → **要**，且最早加（成本极小，晚加要迁移历史）。
2. **任务要不要持久化** → **最小持久化**（状态表 / JSONL），重启后历史可查；但**执行队列不持久化**，重启时把 `running` 标为 `interrupted` 让人重跑，别做断点续传。
3. **外部批注者的身份** → **v1 不做账号体系**。一个任务签发一个**带权限范围的链接 token**（只读这一批 + 只能写标注），回填 `by: 'link:<别名>'`。
4. **第一个落地的异步能力** → **导出**。它最安全（只写新位置，不碰原片）；飞书推送等 004（状态存哪 / 访问控制）与 005（技术栈）定了再做。
