---
id: "011"
title: 网络挂载挂死时的服务健壮性：同步扫描会冻结整个服务、封面抽帧无并发上限
labels: [wayfinder:task]
status: closed
assignee: ""
blocked-by: []
---

## Context

2026-10-06 复跑真库端到端探针时，NAS（gvfs 挂载的 NFS，`/home/qdw/nfs`）在扫描途中挂死，连带暴露出两个健壮性问题。现场证据：

- 服务进程 `State: D (disk sleep)`，`GET /api/v1/health` 超时（探针报 `UND_ERR_HEADERS_TIMEOUT`）；`timeout 5 ls /home/qdw/nfs/` 挂起（exit 124），但 `ping 192.168.3.22` 0% loss。
- 4 个 `ffmpeg ... -i /home/qdw/nfs/.../原视频/*.mp4 ... -f mjpeg -y /tmp/artworks-data/previews/...tmp` 子进程同样卡在挂载上。

## 问题

1. **同步扫描冻结整个服务**：`server/src/core/scan.ts` 走同步 FS（`statSync`/`readdirSync`）。只要网络挂载不返回，扫描线程卡住，服务连 `/health` 都不再应答 —— 前端表现为整个应用失联，而不是「NAS 这个库暂时不可用」。
2. **封面抽帧无并发上限**：进一个视频目录、网格触发多张封面时，`server/src/core/thumbs.ts` 会同时起多个 ffmpeg（现场 4 个），全部卡在挂载上；没有全局并发闸/超时后的降级（单个 `makePoster` 有 120s timeout，但那是一次 exec 的超时，不是队列纪律）。
3. （附带）挂载恢复后需要重启服务才能摆脱卡住的 fd；没有「roots 级熔断」—— 某个 root 不可达时应当只把该 root 标 offline，而不是拖垮进程。

## 待定

- 扫描改为「每 root 带超时 + 失败即标 offline + 下次重试」？还是把 FS 访问挪到 worker/异步？
- ffmpeg 用一个小的并发队列（例如 2）还是按 root 串行？
- 是否在 `/roots` 里加 `lastError`（现在只有 `online: false`），让 UI 能说明原因？

## 验收

- 断掉 NAS（或模拟挂载 hang）时：`/health`、`/roots` 仍可用，`nas` root 显示 offline + 原因，其余 root 正常挑片；进程不进入 D 状态、不需要重启。
- 视频目录快速滚动时 ffmpeg 并发数受控（日志/`ps` 可验证），单张失败不影响其它封面。

（来源：2026-10-06 挂载事故；恢复手法见当次会话记录 —— `pkill -9 -f "[g]vfsd-fuse"` 让服务脱离 D 状态，`fusermount3 -uz /run/user/1000/gvfs` + 重启 `gvfs-daemon.service` 重建挂载点。）

- 2026-10-06（第二条已部分落地）：**索引持久化** —— `dataDir/index.json` 现在连上次扫描的 `records`/目录树/root 在线态一起存（`version: 2`，`server/src/core/library.ts` 的 `loadIndex`/`saveIndex`），冷启动不再需要碰文件系统就能列出照片（`roots()` 优先用缓存里的 `online`，顺带免掉一次对挂载点的 `existsSync`）。回归脚本 `server/tools/e2e-cold-start.mjs`：重启后 673ms 就在 `scanning=true` 的窗口里列出了照片。**注意这不解决本票的正题** —— 扫描本身仍是同步 FS，挂载挂死时依旧会冻结整个进程；待办仍是 ① 扫描的每 root 超时/熔断、② ffmpeg 并发闸。

## Resolution（2026-10-06）

- ① **扫描路径不再有同步 FS**：`core/xmp.ts` 全异步（`readFile`/`writeFile`/`rename`），`scan.ts` 去掉 `existsSync`；热路径上「每张照片读一次 XMP」与「探测缓存是否已抽过图」都不再阻塞事件循环。**并加每根超时闸**：`scanRootIsolated()` 用 `Promise.race` 把单个根的扫描包起来（`scan.rootTimeoutMs`，默认 20s），超时 → 该根 `online:false` + `lastError`，其余根继续扫完；`exiftool` 批次另有 120s 上限。
- ② **ffmpeg 并发受控**：`thumbs.ts` 的 `Gate(2)` 包住 `makePoster()`；连续失败 3 次熔断 5 分钟（错误文案 `视频封面暂缓：源挂载似乎不可用，稍后自动重试`）。实测：清空预览缓存后，对视频目录里 20 条并发请求封面，`pgrep -c -x ffmpeg` 峰值 **2**，20 张全部 200（单张失败也不影响其它）。
- ③ **根级熔断**：超时的根进入 10 分钟冷却（`HUNG_COOLDOWN_MS`），期间的自动/排队扫描直接跳过并记 `跳过 <rootId>：…`；手动 `POST /scan` 清冷却强制重试；启动 `probeRoots()` 3s 探测不阻塞服务；`GET /roots` 新增 `lastError`（契约 + `web/src` 侧边栏/设置页已同步）。
- 验收：`node tools/e2e-hung-mount.mjs` → **18 通过 / 0 失败**（挂死期间四个端点 1–3ms 响应；超时根 offline + 原因；另一个根 11 张照常；排队补扫 502ms 跳过）；`e2e-api.mjs` 98/0、`e2e-cold-start.mjs` 6/0 全绿。
- 遗留（不在本票验收内）：超时后被放弃的那次扫描仍会占住一个 libuv 线程池线程，直到挂载自己返回；真要连这个也解决，得把 FS 访问挪进 worker/子进程（当时的取舍见票内「待定」）。
