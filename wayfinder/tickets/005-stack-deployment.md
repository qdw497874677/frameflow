---
id: "005"
title: 部署形态（已收窄：只剩跑在哪 + 交付方式 + 缓存/HTTPS）
labels: [wayfinder:grilling]
status: closed
assignee: ""
blocked-by: []
---

## 状态（2026-10-07 收窄）

原问题里四分之三已经是代码事实（语言、缓存位置、事务性、认证面），本票只剩**部署**：服务跑在哪台机器上、以什么形态交付、缓存容量与失效、要不要反代/HTTPS。

## 已定（附落地证据）

1. **语言/框架**：服务端 TypeScript（Node 22+），前端 React/Vite，前后端共享契约类型（[ADR 0005](../../docs/adr/0005-typescript-backend.md)；`server/` + `web/`）。
2. **缩略图缓存位置**：服务端本地 `dataDir/previews/<absStem>_<sig>.jpg`（`sig = 源路径+mtime+size`），带 ETag → 304；**不放共享**（网络共享上写小文件慢），冷缓存才读 NAS（`server/src/core/thumbs.ts`）。
3. **索引缓存**：`dataDir/index.json` v2（`records` + `metaCache` + `rootErrors`），冷启动先用缓存服务再后台补扫（提交 `c9aa94f`）。
4. **大批量移动的事务性**：`rename` 只在同一共享内原子 → 回收站放 `<照片目录>/.trash/<显示名>/`；跨共享的「移动」按逐单位 manifest 记账，不当原子操作（[ADR 0004](../../docs/adr/0004-jobs-and-events.md)、[docs/core-model.md](../../docs/core-model.md) §8）；票 011 补上「挂死只让该根不可用，不让服务陪葬」。
5. **认证面**：可选密码 + 三种凭据（session cookie / Bearer API token / 链接 token），已在跑（`server/src/api/auth.ts`；票 004 已定条目 4）。

## Question（收窄后）

1. **服务跑在哪**：NAS 上（数据与服务同机、缩略图与索引不走网络），还是本机/另一台常开机（必须走网络挂载）？
2. **交付形态**：Docker 镜像（compose 单服务，镜像里带 node + sharp + ffmpeg + exiftool），还是裸机 systemd 单元 + 一个 `install.sh`？
3. **缓存容量与失效**：`dataDir` 里的预览缓存要不要加容量上限 + LRU 淘汰？索引多久算过期（现在只靠 mtime+size 判脏）？
4. **反向代理与 HTTPS**：Tailscale 内网 + 可选密码够不够（不加反代），还是要在 NAS 的 nginx 后面挂域名/证书？

## 进展

- 2026-09：**语言已定 —— TypeScript（Node 22 LTS+）**。用户 m01889「可以 用ts 一些功能要支持后续通过模块化的方式集成」；决定与理由见 [ADR 0005](../../docs/adr/0005-typescript-backend.md)（陈述：与前端同语言共享契约类型、`sharp`/`exiftool-vendored` 覆盖图像活、AI 走外部服务时无生态劣势、需要时用 sidecar 逃生）。
- 仍待定（本票余下部分）：部署形态（裸机 systemd / Docker / 反代）、缩略图缓存的位置与失效策略、大批量移动的事务性（断电不产生半个移动）、认证面（会话 cookie + Bearer API token + 链接 token 三种凭据的分工与存放）。
- 2026-09（同轮）：用户 m01948「**照片在我的nas上**」→ 库在 NAS。由此带出的硬约束（实现与部署都照此写）：
  1. **缩略图与索引必须缓存在服务端本地**，不能放共享上（网络共享上写小文件很慢）；缓存键 `path+mtime+size` 不变。
  2. **`rename` 只在同一共享内原子** → 回收站目录必须与被删文件同共享（`dir/.trash`，现有设计已符合）；跨共享的「移动」实际是复制 + 删，不能当作原子操作（导出到别的共享要按 `apply` 的逐单位 manifest 记账）。
  3. **扫描必须增量**（按 `mtime+size` 判脏，重启后从持久化的索引继续），不能每次深扫整个共享；票 001 的「每次重建配对」只适用于已读目录。
  4. 环境事实：本机目前**没有任何网络共享挂载**（`mount` 里无 cifs/nfs）；`exiftool` 未安装（有 perl，`exiftool-vendored` 的 .pl 包可以跑）；docker 可用；只有 `192.168.3.0/24` 一个网段。
  5. 仍待回答：NAS 型号/系统（能否跑 Docker、共享协议 SMB/NFS/WebDAV、是否区分大小写）与服务最终跑在哪 —— 我倾向**跑在 NAS 上**（数据与服务同机，缩略图不走网络）；若 NAS 不支持容器，则本机挂载 SMB/NFS + 服务跑本机。

- 2026-10-07 环境事实（本机侧）：
  - NAS 只有 NFS 挂载（gvfs，`/home/qdw/nfs`）；本机**没有 `mount.nfs` 辅助程序**（`nfs-utils` 未装）且无 root，所以**只能用 gvfs 这条 NFS 通路**。
  - NAS 端口：80（nginx，302 到 :5666）、443、3000（nginx + Basic auth）、111、2049 开；445/5000/5001 关；22 时开时拒；ping 0.9ms。
  - **gvfs NFS 挂载已第三次 wedge**（2026-10-07）：`stat` 单文件卡在 D 状态（`request_wait_answer`）、`ls` 8 秒超时，而同一时刻应用 `/health` 0.6ms、`/roots` 0.7ms —— 票 011 的修法生效（服务不陪葬），但**依赖 gvfs 挂载本身就是不稳的**，这是「服务跑在哪」这个决策的关键事实。

## Resolution（2026-10-07）

四条按用户 m01213 / m01216 定：

1. **服务跑在哪**：以后**直接连 NAS**（数据与服务同机 —— 扫描、缩略图/索引生成、XMP 读写、回收站都是本地操作），但**不把「本地盘」写死**：根就是目录路径，代码里不出现「挂载类型/协议」概念，同一套服务适配 NAS 本地盘、本机 NFS、SMB 挂载、USB/内置盘。跨协议的约束已在实现里：`rename` 只在同一共享内原子（回收站放照片目录内）、不依赖 `inotify`（手动/增量扫描）、配对按 stem 大小写不敏感。
2. **交付形态**：**两条路都提供，最终用 Docker compose** —— 镜像里带 node + sharp + ffmpeg + exiftool，卷挂「照片目录 + dataDir」；裸机路线保留 systemd 单元 + `install.sh`（给不想跑容器的机器，也方便调试）。
3. **缓存容量与失效**：预览缓存是**服务端本地磁盘缓存**（`dataDir/previews/`，512/2048 两档 JPEG，键 = 源路径+mtime+size），**不是内存缓存**；容量上限可配（默认 8 GB，`cache.maxBytes`），启动时按 atime 做 LRU 淘汰；索引不设过期（`mtime+size` 判脏），另加「上次扫描超过 N 天则启动时自动补扫」。
4. **反代与 HTTPS**：只在**内网 / Tailscale**，不加反代与证书；将来对外的批注链接靠范围 token 收口，不靠 HTTPS 兜底。

落地拆成两张 task 票：[012 部署交付物](012-deployment-artifacts.md)、[013 缓存上限与启动补扫](013-cache-policy.md)。
