---
id: "013"
title: 预览缓存上限 + LRU 淘汰 + 启动自动补扫
labels: [wayfinder:task]
status: closed
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

## Resolution（2026-10-08，全部验收达成）

- 新模块 `server/src/core/cache.ts`：`CacheJanitor`（measure/sweep/stats）+ `touchIfStale`。验收逐条：
  - `cache.maxBytes` 进 `Config`（默认 `8*1024**3`，`0`/写错 = 不限，`ARTWORKS_CACHE_MAX_BYTES` 可覆盖）✓；
  - 淘汰按 atime 从旧到新删到 `maxBytes*0.9` 停 ✓（relatime 下读命中时顺手刷新 atime，旧过 1h 才刷一次，避免每请求写元数据）；
  - 起监听后 `maintainCache()` 后台跑（measure + 最多 10 轮 sweep，轮间 `setImmediate`），每 10 分钟巡检；单轮 `walk()` 最多 2000 文件（`truncated` 时下轮继续）✓；
  - 在途保护：`Thumbs.protectedPaths()` = inflight ∪ 视频封面，受保护文件跳过不腾地方（继续删更旧的）✓；半截 `.tmp` 不计入占用，1h 后自动清；
  - `scan.autoRescanAfterDays`（默认 7，`0` = 关，`ARTWORKS_AUTO_RESCAN_DAYS` 可覆盖）✓ —— **设计决定：不跳过启动扫描**（否则破坏冷启动语义与 `e2e-cold-start` 断言）；实现为「启动扫描即补扫 + 长期实例每 10 分钟检查」；
  - 可观测：`/capabilities.library.cache`（bytes/files/maxBytes/lastEvict）+ `library.autoRescan`（afterDays/lastScanAt/triggeredAt）+ 启动/巡检日志 ✓；
  - 回归 `server/tools/e2e-cache.mjs` **35/0**（A 段直驱 CacheJanitor 断言淘汰顺序/90%/单轮预算/在途保护/maxBytes=0，B 段独立实例：启动淘汰、capabilities 字段、淘汰后按需重建缩略图、索引过期启动补扫）；全套回归 **e2e-api 109/0、e2e-jobs 81/0、e2e-annotate 94/0、e2e-cold-start 6/0、e2e-hung-mount 21/0** ✓；
  - 文档：`server/README.md` 新增「预览缓存与自动补扫」节 + 模块表 `cache` 行；契约 `LibraryStatus`/`CacheStats` schema 进 `contracts/openapi.yaml`；`web/src/api/contract.ts` 无 capabilities 类型（前端不调 `/capabilities`），无需同步（票内已备注）；`artworks.config.example.yaml` 补两键。
- 顺手修的纸划伤：`~` 前缀展开（`expandHome`）—— dataDir/roots/`/fs/browse`/`addRoot` 都认 `~/x`（此前示例配置里的 `dataDir: ~/.local/share/artworks` 会落到字面量 `~` 目录）。
- 验证：server `npm run typecheck`、web `tsc --noEmit` + build 干净；`dev.sh restart` 后 `/capabilities.library` 字段实测正确。
