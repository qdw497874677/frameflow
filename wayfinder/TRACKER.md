# 本地 markdown tracker 约定

- 地图：`wayfinder/map.md`（label `wayfinder:map`），是唯一权威索引
- 票：`wayfinder/tickets/*.md`，frontmatter 字段：`id / title / labels / status(open|closed) / assignee / blocked-by`
- 认领 = 写 `assignee`（未认领的 open 票才可认领）；关闭 = 追加 `## Resolution` 章节并把 `status` 改为 `closed`，同时在地图 Decisions so far 追加一行
- 阻塞：`blocked-by` 填票的 id 列表；前沿查询 = status open 且 assignee 为空且所有 blocked-by 已 closed
- 票的类型 label：`wayfinder:research | prototype | grilling | task`
- 调研产物放 `wayfinder/research/`，票里只放链接
