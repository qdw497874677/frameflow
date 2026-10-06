---
id: "011"
title: 网络挂载挂死时的服务健壮性：同步扫描会冻结整个服务、封面抽帧无并发上限
labels: [wayfinder:task]
status: open
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
