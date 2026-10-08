---
id: "009"
title: AI 接入面：AI 作为执行者与 AI 作为客户端
labels: [wayfinder:grilling]
status: closed
assignee: ""
blocked-by: []
---

## Question

用户要求（m01899）：「尤其是 ai，后续是急需集成的，并且也要能够提供 ai 可用的 api 来让 ai 介入选片工作流」。
设计草案见 `docs/core-model.md` §11；后端语言已定 TypeScript（[ADR 0005](../../docs/adr/0005-typescript-backend.md)）。

要定的事：

1. **先做哪条路径**：`pull`（AI 作为客户端来取活干 —— 我们的进程不存 key、不花钱、换模型只换客户端）还是 `push`（我们创建 `annotate` 任务去调模型）？还是先 pull 后 push？
2. **结果形态**：AI 直接写标注（靠 `by: 'ai:<model>'` 区分来源，UI 按来源显示、可用 `?sel=by:ai` 过滤）还是引入独立的「建议」实体？草案倾向前者（省一张表，回滚依据是 `marks.jsonl`）。
3. **MCP 是否必做**：MCP 适配器（`list_photos` / `get_photo` / `set_marks` / `create_job` / `job_status`）进 v1，还是先给 REST + Bearer token 就够？
4. **token 范围**：AI 的 Bearer token 是全权限（等价本人）还是限范围（只读某项目 + 只写标注、不能真删）？
5. **外部领取机制**：pull 形态要不要 claim/lease（AI 领走一批照片、超时释放、避免两个 AI 撞车），还是无状态（AI 自己算好一批、直接批量写回）？

产出：AI 接入面的第一版决定（其余细节随实现推进）。

## 进展

- 2026-09：用户 m01948「**ai先做让agent调用**」→ **第 1 问已定：先做 pull（AI 作为客户端），push（annotate 任务）后置。** 由此带出的实现要点（写进契约与 core-model §11）：
  1. **认证**：`POST /api-tokens` 签发长期 Bearer token（可撤销、记 `lastUsedAt`、`scope` 可限范围）；浏览器仍用会话 cookie。
  2. **缩略图 URL 必须自认证**（`?t=<链接 token 或短期签名>`）—— agent 是把图片 URL 交给**自己的**图像加载器/模型去取，带不上自定义 header；这是 pull 路线唯一一处「与 push 不同」的接口要求。
  3. **挑片循环无状态**（倾向上「不要 claim/lease」）：`GET /photos?sel=marked:false&limit=50` → 逐张取 2048 缩略图 → 判断 → `PUT /marks`（`by: 'ai:<model>'`）；`?sel=by:ai` 可复核/清空 AI 的标注。两个 AI 撞车只会在同一张上写两次，日志留痕，没有租约也能收敛。
  4. 待定（本票余下）：第 2 问（直接落标 vs 建议层，草案倾向前者）、第 3 问（MCP 是否 v1 —— 倾向先给 REST + Bearer + `/capabilities` + 一份 agent 接入说明，MCP 作薄包装后补）、第 4 问（token 是否限范围 —— 倾向 v1 全权限，限范围随链接 token 一起做）、第 5 问（claim/lease —— 倾向上不做）。

## Resolution（2026-10-08，五问全部拍板）

1. **先 pull 后 push**（已定，m01948）——已落地：Bearer + linkToken + `/capabilities`。
2. **直接落标，不做建议层**：AI 写标注靠 `by: 'ai:<label>'` 区分（Bearer 自动打标，label=token 名，建议直接写模型名）；复核/清空用 `?sel=by:ai`；回滚依据 = `marks.jsonl`（`GET /marks/history`）。不新增「提案」实体 —— 省一张表，与既有 provenance 语义一致。
3. **MCP 不进 v1**：REST + Bearer + 自认证缩略图 URL + `/capabilities` 自描述 + **agent 接入说明 `docs/agent-access.md`（本票交付）**已够 agent 干活（当前唯一消费者是 pi/通用 agent，直接 HTTP 可用）。MCP 作为将来薄包装（工具↔端点一比一映射：list_photos/get_photo/set_marks/create_job/job_status），出现第二个真实消费者再立项。
4. **token 范围 v1 不限制**：Bearer 等价本人（`scope` 字段已存、默认 `full`，强制执行后置）；只读缩略图的范围限制已由 linkToken 覆盖；范围受限的第三凭据 = 批注任务 token（008/015 已落地）。红线只有一条：真删磁盘（`POST /trash?confirm=true`）agent 不碰（人工确认，不变量 1）。
5. **不做 claim/lease**：无状态循环（list → thumb → marks）+ `marks.jsonl` 后写覆盖留痕，两个 agent 撞车最多双写、能收敛；要「领一批」的确定性用任务层（items 快照 + inbound 幂等，天然租约形状）。

顺手补的实情澄清：`/capabilities.executors` 原来返回三个执行者（ollama/openai/anthropic）但没有一个实现了 —— push 后置时这会骗到 agent；现在每项带 `status: 'planned'`，`notes` 同步指到 agent 接入文档。

- 2026-10-06：**缩略图自认证 URL 落地**（真库 + 认证打开形态实测通过）。此前只有验证函数、没有签发入口，认证一开 agent 就取不到图；现在 `POST /api-tokens` 的 201 响应一并给出 `linkToken / linkExpiresAt / thumbUrlTemplate`（`/api/v1/photos/{id}/thumb?size={size}&t=<linkToken>`）：
  1. 载荷 `link|<tokenId>|<exp>`，TTL 30 天；**绑的是签发它的那条 API token**，撤销即失效（实测撤销后 Bearer 与 linkToken 一起 401）。
  2. **照片无关**：一个 linkToken 能取全库缩略图（agent 要的是一次签发、批量拉图；逐张签 URL 不现实）。`?t=` 只在 `/thumb` 路由被消费 —— 放 `/photos`、`/capabilities` 查询串或 `/file` 上都不算凭据（实测 401）。
  3. 视频封面走同一条路：服务端 ffmpeg 抽第 1 秒一帧（失败回退第 0 帧），缓存进本地缩略图缓存，`preview` 记 `video_poster`；无 header 也能取到。
  4. 第 4 问的「限范围」由此先落一半：linkToken 只有缩略图只读；**Bearer 仍是全权限**（能写标注、能下原图，含 `?variant=video`）—— 只读某项目 + 只写标注、不能真删的范围限制仍待定。
