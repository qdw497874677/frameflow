---
id: "008"
title: 任务与外部批注的 API 形状
labels: [wayfinder:grilling]
status: closed
assignee: ""
blocked-by: []
---

## Question

骨架已定：动作层统一为**任务**，通道负责派发与回流（[docs/core-model.md](../../docs/core-model.md)、[ADR 0004](../../docs/adr/0004-jobs-and-events.md)）。
这一票要把它落到能写进 `contracts/openapi.yaml` 的具体形状上 —— 目标是「挑一批 → 推到外部批注 → 结果回流合并」，而不是只服务导出。

要定的事：

1. **任务资源的字段**：`kind / selection / params / state / progress / manifest / artifacts` 各自要到什么粒度？manifest 记到「文件」还是「照片（组）」？产物（导出目录、报告文件）怎么指？
2. **选择集的表达**：谓词字段集合是否够（项目 / kind / stars / del / marked / taken / folder / camera）？要不要命名保存（`POST /selections`）还是 v1 只做内联谓词 + 手选 id 列表？
3. **回流协议**：外部批注（飞书卡片点击 / 其他客户端）经什么端点进来（`POST /channels/{id}/inbound`）？载荷带什么（photoId、stars/del、by、at、幂等键）？冲突策略（后写覆盖 + 保留历史）在 API 上怎么体现 —— 要不要乐观并发（带 `expectedFrom`）？
4. **身份与权限**：外部批注者不做账号体系，那就得定 token 的形态与范围（只读这一批 + 只能写标注、有效期、能否撤销）。它同时决定 004 的访问控制怎么设计。
5. **进度流**：`GET /jobs/{id}/events` 用 SSE 还是轮询？重连与补发（`Last-Event-ID`）要不要在 v1 做？
6. **同步便捷入口的边界**：`/trash` 保留为同步路径，与 `kind: 'trash'` 的任务是什么关系（同一实体的即时执行？还是两套实现）？哪些能力允许有便捷入口？

产物：写进 `contracts/openapi.yaml` 的 `/jobs`、`/channels`、`/marks/history`，以及一段端到端故事（把「挑 20 张推到飞书，同事标完回流」走一遍）。

## Resolution（2026-10-06）

六问的答案已写进 `contracts/openapi.yaml`（`/jobs`、`/jobs/{id}`、`/jobs/{id}/events`、`/jobs/{id}/inbound`、`/channels`、`/marks/history`）：

1. **任务字段粒度**：`selection` 存谓词（「怎么选出来的」凭据），`items[]` 存**创建时展开的快照** —— 派发出去的那一批必须稳定，人看到的和系统记的是同一批。粒度是**照片配对组**（RAW+JPEG 是一个单位，与 marks/回收站的 pair 语义一致），不是文件；`progress` 数 items。`artifacts` 对 annotate 是发出去的卡片/链接（`kind: message | url`），对 export 是目录/文件。`mode: plan` 只展开 items 不落库，人看过再 `apply`。
2. **选择集表达**：v1 **不做** `POST /selections`。快照已由 `items` 解决；命名保存是浏览侧（智能相册）的功能，与任务层无关。手选继续用 `selection.ids`。
3. **回流协议**：端点从 `/channels/{id}/inbound` 改成 **`POST /jobs/{id}/inbound`** —— 通道只出站，回流是任务的事（任务才是进度/审计/撤销的单位）。载荷 `{ items: [{ photoId, stars?, del?, at?, clientRef? }] }`；`by` **不由客户端给**，从 token 别名推 `link:<别名>`（避免伪造）。幂等 = 每条 `clientRef`（重复提交跳过并返回首次结果 —— 外部系统会整批重发）。冲突 = 后写覆盖 + 历史留痕（`marks.jsonl` 的 `from→to` 与任务事件流都能对账）；乐观并发（`expectedFrom`）v1 不做。
4. **身份与权限**：不做账号体系，把链接 token 扩成**范围 token**（载荷 `annotate:<jobId>`）：只读该任务的选择集 + 缩略图、只能 POST 该任务的 inbound、有效期 30 天、可撤销；`?t=` 或 `Authorization: Bearer` 都认。范围 token 绑定签发它的 API token，撤销即失效。
5. **进度流**：v1 用**增量轮询** `GET /jobs/{id}/events?since=<seq>` → `{ items: JobEvent[], nextSince }`，事件带单调递增 `seq`。将来要实时推送时在同一形状上加 SSE（`Last-Event-ID` = `seq`，日志可重放）—— 契约先不标 SSE。
6. **同步便捷入口**：`/trash` 保持同步，**不设** `kind:'trash'`（不做同一实体的两套实现）。规则：同步、单工作单位、没有进度 → 便捷入口（`PUT /marks`、`/trash`、`POST /scan`）；长跑、多步、有进度或需要审计 → `/jobs`。kind 先只落 `annotate`。

顺带修的契约漂移：`Selection.where.by`（「最后一次标注变更是谁做的」）此前只在 `contracts/selection.md` 与 `server/src/core/selection.ts` 里有，现补进 schema（并注明前端 `matchesSelection` 暂不支持）；`docs/core-model.md` 的端点清单与扩展配方里 `/channels/{id}/inbound` 全部改为 `/jobs/{id}/inbound`；`server/README.md` 的 `channels` 行与「预留形状」列表同步。

**端到端故事**（把「挑 20 张推到飞书，同事标完回流」走一遍）：

```
POST /jobs {kind:'annotate', selection:{where:{stars:{gte:4}}}, params:{channel:'feishu', label:'老婆'}}
  → 服务端展开 20 个 items + 签发 annotate:<jobId> 链接 + 发飞书卡片（artifacts）
  → 同事点链接（页面用 ?t= 取缩略图）标完 → POST /jobs/{id}/inbound（每条带 clientRef）
  → 服务端按 by:'link:老婆' 写 XMP + marks.jsonl + 任务事件，progress.done 到 20/20
  → 你打开任务页轮询 events?since= 看进度，GET /marks/history?jobId= 逐条对账/撤销
```

**实现拆成两张 task 票**：[014](014-jobs-core.md)（任务层核心）+ [015](015-annotate-dispatch.md)（批注派发与回流）。
