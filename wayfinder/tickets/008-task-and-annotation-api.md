---
id: "008"
title: 任务与外部批注的 API 形状
labels: [wayfinder:grilling]
status: open
assignee: ""
blocked-by: ["004"]
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
