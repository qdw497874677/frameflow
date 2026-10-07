---
id: "013"
title: 预览缓存上限 + LRU 淘汰 + 启动自动补扫
labels: [wayfinder:task]
status: open
assignee: ""
blocked-by: []
---

## 目标

按 [005](005-stack-deployment.md) Resolution 条目 3 给磁盘缓存加策略：上限可配（默认 8 GB）、启动时按 atime LRU 淘汰；索引加「上次扫描超过 N 天则启动自动补扫」。

## 验收

- 配置 `cache.maxBytes`（默认 `8 * 1024 ** 3`；`0` 或缺省视为不限），配置项进 `server/src/config.ts` 的 `Config`（可用 `ARTWORKS_CACHE_MAX_BYTES` 覆盖）。
- 超限时淘汰最久未访问的预览文件（512/2048 两档一起算），**删到上限的 90%** 就停，避免每次启动都刚好压线。
- 淘汰在服务起监听**之后**后台跑；单轮最多扫 N 个文件（比如 2000），大库启动不卡。
- 在途保护：正在被请求生成的预览不会被删（复用 `thumbs.ts` 的 in-flight 集合）。
- `scan.autoRescanAfterDays`（默认 7；`0` = 关）：`index.json` 的 `lastScanAt` 更早则启动后补扫一次。
- 可观测：日志 + `/capabilities.library` 能看到缓存当前字节数/文件数、本轮淘汰了多少、是否触发了自动补扫。
- 回归：新增 `server/tools/e2e-cache.mjs` —— 用小上限 + 伪造 mtime/atime 的预览文件断言淘汰顺序与「删到 90%」；`e2e-api.mjs`、`e2e-cold-start.mjs`、`e2e-hung-mount.mjs` 仍全绿。
- 文档：`server/README.md` 的「索引缓存与冷启动」一节补缓存策略；`contracts/openapi.yaml` 的 `/capabilities.library` 若加字段要同步 `web/src/api/contract.ts`。

## 进展

- 2026-10-07 开票（005 落地拆票）。
- 相关现状：预览缓存键 = `源路径+mtime+size`（`server/src/core/thumbs.ts` 的 `previewKey`），目录 `dataDir/previews/`；索引 `dataDir/index.json` v2（`records` + `metaCache` + `rootErrors`），冷启动先用缓存服务再后台补扫（`c9aa94f`）。
