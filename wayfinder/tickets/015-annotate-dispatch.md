---
id: "015"
title: 批注任务：annotate handler + 范围 token + 回流
labels: [wayfinder:task]
status: closed
assignee: ""
blocked-by: ["014"]
---

## 目标

落**第一个真 kind**：把一批照片派给外部批注人，批注结果回流直接落盘。通道 v1 先做**应用内（inapp）**—— 不需要任何外部凭据，一条链接就能把批次交给另一台设备/另一个人；飞书卡片投递是通道插件的第二例，单开票。

回流语义已由 [004](004-product-skeleton.md) 与 [008](008-task-and-annotation-api.md) 定死：**直接落** XMP + `marks.jsonl`（不做建议层），冲突后写覆盖 + 历史留痕，`by: 'link:<批注人>'`，幂等靠 `clientRef`。

## 验收

- **创建**：`POST /jobs {kind:'annotate', selection, params:{channel:'inapp', label:'老婆'}, mode:'apply'}` → 展开 items 快照（照片配对组）→ 签发**范围 token**（载荷 `annotate:<jobId>`、别名 `label`、有效期 30 天、绑定签发它的 API token，撤销即失效）→ `artifacts` 记一条 `kind: 'url'` 的批次链接 → 任务进 `running`（等回流）。
  批注人拿到的链接页面**免登录**：`?t=<范围 token>`（页面本身可以后做，后端先把取数跑通）。
- **只读范围**：范围 token 只能读该任务的 items + 这些照片的缩略图（`GET /photos/{id}/thumb?t=`），读任务外的东西一律 404/403。
- **回流**：`POST /jobs/{id}/inbound`（范围 token 或主凭据）`{items:[{photoId, stars?, del?, at?, clientRef?}]}`：
  - `by` 由 token 里的批注人推出（`link:<批注人>`），请求体给的一律忽略（防伪造）；主凭据调时按 `me`。
  - 只接受该任务 items 里的 photoId，别的 404。
  - 写标注走既有统一路径（XMP + `marks.jsonl`），落 `from → to` 与 `channel`，`GET /marks/history?jobId=` 可逐条对账/撤销。
  - 幂等：`clientRef` 重复提交跳过并返回首次结果（外部系统会整批重发），事件里记 `skipped`。
  - 进度：`progress.done` 随 items 终态推进；全部有终态 → 任务 `done`。
- **撤销**：任务撤销（`POST /jobs/{id}/undo`）把本任务写入的标注回滚到变更前（走 `marks.jsonl` 的 `from`），并把任务标 `cancelled/undone` 语义按 014 的状态机落地。
- **测试**：`server/tools/e2e-annotate.mjs` —— 建任务 → 用范围 token 读缩略图 200、读任务外照片 404、`POST inbound` 标 3 张 → `progress` 3/N → 幂等重发不重复 → 主凭据 `GET /marks/history?jobId=` 能看到 `by:'link:<批注人>'` 的 `from→to` → `undo` 回滚干净 → 撤销 API token 后范围 token 立即失效。
- **不做**：飞书/webhook 通道（需要凭据，单开票）、批注页视觉与交互（另开票）、建议层与乐观并发（008 已定 v1 不做）、通知与提醒。

## 进展

- 2026-10-06 开票（008 Resolution 落地拆票）。
- 2026-10-07 实现完成：`server/src/jobs/annotate.ts`（validate/plan/apply/inbound/undo）+ `server/src/jobs/channels.ts`（内置 `inapp`）+ `server/src/api/auth.ts` 的第四种凭据（任务范围 token）。回归 `node tools/e2e-annotate.mjs` **76 通过 / 0 失败**（自带 fixture 库 + 独立端口 8790 + 独立 dataDir）。

## Resolution（2026-10-07）

- **创建**：`POST /jobs {kind:'annotate', selection, params:{channel:'inapp', label:'老婆'}, mode:'apply'}` → 展开 items 快照（配对组）→ 签发**任务范围 token** → `artifacts` 记一条 `kind:'url'`（`/j?t=<token>`，批注页见 016）→ 任务进 `running` 等回流（不等）。
- **范围 token（第四种凭据）**：载荷 `annotate|<jobId>|<批注人>|<exp>|<tokenId>`（第 5 段是签发它的 API token id，`-` = 会话/免认证签发），HMAC 签名、**不依赖也不写 `tokens.json`**，TTL 30 天；`?t=` 只在本任务 items 的缩略图路由与 `POST /jobs/{id}/inbound` 上被消费 —— 其它路径一律不放行（没带凭据 401、越界 404），任务取消/撤销后 403；撤销签发它的 API token 即失效（e2e 有断言）；只读的缩略图 `linkToken` 拿去写回流一律 401。
- **回流**：`POST /jobs/{id}/inbound` 的 `by` 一律由 token 里的批注人推（`link:<批注人>`，**请求体里的 `by` 被忽略**）、`channel` 取任务 `params.channel`；写标注走既有统一路径（XMP + `marks.jsonl`，落 `from → to`），`GET /marks/history?jobId=` 可逐条对账；`clientRef` 幂等（重复提交跳过、返回首次结果、事件记 `skipped`）；`progress.done` 随 items 终态推进，全部终态 → `done`。
- **撤销**：`POST /jobs/{id}/undo` 用 `marks.jsonl` 里本任务写下的最早 `from` 回滚（记 `channel:'undo'`、`by:'me'`），任务落 `cancelled` + `undone` 事件。
- **不做（保持）**：飞书/webhook 通道（需要凭据，另开票）、批注页视觉与交互（016）、建议层与乐观并发、通知与提醒。

遗留（记在案）：`inapp` 通道只是把链接记进 artifacts，投递靠人把链接发出去；真正的「发出去」（飞书卡片/webhook）是通道插件的第一张后续票。
