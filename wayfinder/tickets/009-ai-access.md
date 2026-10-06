---
id: "009"
title: AI 接入面：AI 作为执行者与 AI 作为客户端
labels: [wayfinder:grilling]
status: open
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

- 2026-10-06：**缩略图自认证 URL 落地**（真库 + 认证打开形态实测通过）。此前只有验证函数、没有签发入口，认证一开 agent 就取不到图；现在 `POST /api-tokens` 的 201 响应一并给出 `linkToken / linkExpiresAt / thumbUrlTemplate`（`/api/v1/photos/{id}/thumb?size={size}&t=<linkToken>`）：
  1. 载荷 `link|<tokenId>|<exp>`，TTL 30 天；**绑的是签发它的那条 API token**，撤销即失效（实测撤销后 Bearer 与 linkToken 一起 401）。
  2. **照片无关**：一个 linkToken 能取全库缩略图（agent 要的是一次签发、批量拉图；逐张签 URL 不现实）。`?t=` 只在 `/thumb` 路由被消费 —— 放 `/photos`、`/capabilities` 查询串或 `/file` 上都不算凭据（实测 401）。
  3. 视频封面走同一条路：服务端 ffmpeg 抽第 1 秒一帧（失败回退第 0 帧），缓存进本地缩略图缓存，`preview` 记 `video_poster`；无 header 也能取到。
  4. 第 4 问的「限范围」由此先落一半：linkToken 只有缩略图只读；**Bearer 仍是全权限**（能写标注、能下原图，含 `?variant=video`）—— 只读某项目 + 只写标注、不能真删的范围限制仍待定。
