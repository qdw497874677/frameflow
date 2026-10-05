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
