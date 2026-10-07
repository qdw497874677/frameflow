---
id: "014"
title: 任务层核心：任务存储 + 状态机 + 事件日志 + /jobs API
labels: [wayfinder:task]
status: closed
assignee: ""
blocked-by: []
---

## 目标

把 [008](008-task-and-annotation-api.md) Resolution 敲定的任务层**框架**落进后端：契约里 `/jobs` 家族的 `x-implemented: false` 变成真实现，一个 kind 一个文件的 handler 注册进来就能跑（第一个真 kind 是 `annotate`，见 [015](015-annotate-dispatch.md)）。

任务 = 最小可追踪单位：`selection`（谓词）+ 操作（`kind`）+ `params` → 创建时展开 `items` 快照 → 状态 + 进度 + manifest + artifacts + 事件流水。

## 验收

- **持久化**：`dataDir/jobs.jsonl`（追加型 JSONL，一行一个任务或一次状态/进度更新；启动重放还原内存表）；事件日志（每任务一个文件或一张 `job-events.jsonl`，`seq` 单调递增、只追加）。重启后 `running` → `interrupted`（不假装还在跑），未跑完的任务可 `undo` 或重开。
- **状态机**：`planned → queued → running → done | failed | cancelled`（+ `interrupted` 收敛态）；非法迁移按 409 拒绝，错误响应复用 `Error` schema。
- **Handler 注册表**：`JobHandler { kind, validate(input, lib): Promise<Problem[]>, plan(input, lib): Promise<Plan>, apply(plan, sink): Promise<Outcome>, undo?(outcome, lib) }`（形状见 [docs/core-model.md](../../docs/core-model.md) §7）；一个 kind 一个文件，注册表导出 `handlers` 映射；未注册的 kind 在 `validate` 阶段返回 400 并列出可用 kind。
- **端点全实现**（同时删掉 `contracts/openapi.yaml` 里对应的 `x-implemented: false`）：
  - `POST /jobs`：`mode: plan` 只展开 items 不落库（预演）；`mode: apply` 落库 + 入队；创建时把 `selection` 谓词展开成 **items 快照**（照片配对组为单位）。
  - `GET /jobs?state=&limit=`、`GET /jobs/{id}`（含 items/progress/artifacts/error/reversible）。
  - `GET /jobs/{id}/events?since=&limit=` → `{ items, nextSince }`（增量轮询，`seq` 当游标）。
  - `POST /jobs/{id}/cancel`、`POST /jobs/{id}/undo`（handler 声明 `reversible` 才可 undo，否则 409）。
- **选择集展开**：服务端可求值（`project` + `where` + `ids`，字段间 AND，语义与 `contracts/selection.md` 一致）；缺服务端实现时补齐 `server/src/core/selection.ts`，并被 `GET /photos` 与 `/jobs` 共用（同一份语义，不许两套）。
- **前端接口层**：`web/src/api/` 拆出 `JobSource`（`createJob/planJob/listJobs/getJob/jobEvents/cancelJob/undoJob`；`httpSource` 真实现 + `mockSource` 内存实现 + `contract.ts` 类型 + `source.ts` 组合）。**不做任务页 UI**（另开票）。
- **测试**：`server/tools/e2e-jobs.mjs` —— 建任务→items 快照稳定（改谓词/删照片不影响已建任务）→progress 单调增→事件 `seq` 递增可增量取→非法迁移 409→cancel/undo 路径→（模拟重启或直接重放日志）`interrupted` 收敛；`e2e-api.mjs` 仍全绿。
- **不做**：SSE（v1 轮询，形状已留）、调度器/定时任务、worker 进程池与并发队列、账号与细粒度权限（沿用现有 auth）。

## 进展

- 2026-10-06 开票（008 Resolution 落地拆票）。
- 约束：`erasableSyntaxOnly`（禁 enum / 构造函数参数属性）、相对导入必须带 `.ts` 后缀、不加新依赖。
- 2026-10-07 实现完成（后端）：`server/src/core/jobs.ts`（`JobsStore`：`dataDir/jobs.jsonl` 一行一快照、同 id 后写覆盖先写 + `dataDir/job-events.jsonl` 只追加、`seq` 全局单调；启动重放；`TRANSITIONS` 状态机，非法迁移 409；重启把 `queued`/`running` 收敛成 `interrupted` 并留 note）、`server/src/jobs/registry.ts`（`JobHandler` + 注册表，未注册 kind → 400 并列出可用 kind）、`server/src/jobs/service.ts`（`JobsService`：plan/apply 分叉、进程内 pump、cancel/undo/inbound/settle）。

## Resolution（2026-10-07）

按验收项逐条落地，回归 `node tools/e2e-jobs.mjs` **74 通过 / 0 失败**（自带 fixture 库 + 独立端口 8789 + 独立 dataDir，不碰真库）；`e2e-api.mjs` 109/0 仍全绿。

- **持久化**：两份追加型 JSONL 都在 `dataDir`；`jobs.jsonl` 存任务快照（同 id 后写覆盖先写，重放取最后一条），`job-events.jsonl` 只追加、`seq` 全局单调 → 天然就是 `?since=` 游标。重启把 `queued`/`running` 收敛为 `interrupted`（不假装还在跑）。
- **状态机**：`planned → queued → running → done | failed | cancelled`（+ `interrupted`），非法迁移按 409 拒绝。
- **端点**：`POST /jobs`（`mode:'plan'` 只展开 items、返回 `id:"plan"`、不落库不签 token；`apply` 落库入队）、`GET /jobs?state=&limit=`、`GET /jobs/{id}`、`GET /jobs/{id}/events?since=&limit=` → `{items,nextSince}`、`POST /jobs/{id}/cancel`、`POST /jobs/{id}/undo`（handler 声明 `undoable` 才可）。契约里 `/jobs` 家族与 `/channels` 的 `x-implemented` 全部转 `true`。
- **items 快照**：创建那一刻展开（照片配对组为单位），之后改谓词、移走/删掉照片都不动已建任务 —— e2e 里专门断言了这一点。
- **前端接口层**：`web/src/api/source.ts` 拆出 `JobSource`（`createJob/planJob/listJobs/getJob/jobEvents/cancelJob/undoJob/listChannels`），`httpSource` 真实现 + `mockSource` 内存实现 + `contract.ts`/`core/types.ts` 类型；**任务页 UI 不在本票**（见 016）。
- **明确不做（保持）**：SSE、调度器、worker 进程池与并发队列、账号与细粒度权限。执行队列只活在进程内（重启即收敛为 `interrupted`），符合 §10 第 2 条「最小持久化」。

遗留（记在案，不阻塞）：进程内 runner 是单 pump，长任务会占着事件循环的一个异步位；将来多 kind / 并发任务多起来再谈队列。
