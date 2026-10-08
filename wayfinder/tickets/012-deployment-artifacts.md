---
id: "012"
title: 部署交付物：Docker 镜像 + compose + systemd 单元 + install.sh
labels: [wayfinder:task]
status: closed
assignee: ""
blocked-by: []
---

## 目标

把 `server/` 和构建好的前端打成**可部署的交付物**，让「服务直接跑在 NAS 上」这件事可执行（决定见 [005](005-stack-deployment.md) Resolution 条目 2：两条路都提供，最终用 Docker compose）。

## 验收

- **Docker 路线**：`docker compose up -d` 一条命令起服务。
  - 多阶段构建：builder 装依赖 + `VITE_API_BASE=/api/v1 npm run build` 出前端；runtime 只带运行期依赖（node 22+、sharp、ffmpeg、exiftool-vendored 的 perl 包），前端 `dist` 由服务端托管在同一端口 8787。
  - 卷：照片根目录（**读写** —— 要写 XMP 与 `.trash`）+ `dataDir`（索引 / 预览缓存 / `tokens.json` / `marks.jsonl` / `trash.jsonl`）。
  - 配置：`artworks.config.yaml` 挂进容器（或 `ARTWORKS_CONFIG` 指路径），roots 写容器内路径；密码可选。
  - 健康检查：容器 healthcheck 打 `/api/v1/health`。
- **裸机路线**：`deploy/install.sh`（检查 node/ffmpeg/perl → `npm ci` → 建 `~/.config/systemd/user/artworks.service` 或系统级单元 → enable + start）与单元模板；两条路都在 README 有步骤。
- **文档**：根 `README.md` 新增「部署」节 —— Docker 与裸机两条路、Tailscale 访问方式、`dataDir` 备份说明（索引/预览/token/标注历史都在里面）、升级步骤（`git pull` + 重新 build + restart）。
- **验证**：本机 `docker` 可用 → 用测试库 `/home/qdw/Pictures/artworks-test` 真起一遍，`/api/v1/health` 200、扫出照片、能打星；`e2e-api.mjs` 仍全绿。
- **不做**：自动更新、镜像推 registry、K8s、多副本。

## 进展

- 2026-10-07 开票（005 落地拆票）。
- 已知坑：前端 build 不带 `VITE_API_BASE=/api/v1` 会静默打进 mock 数据源；`erasableSyntaxOnly` 禁参数属性/enum；相对导入必须带 `.ts` 后缀。
- 2026-10-08 交付物完成（部署产物由子 agent 产出，验证与文档由主线补齐）。

## Resolution（2026-10-08）

- **Docker 路线**：`Dockerfile`（多阶段：builder `npm ci` + `VITE_API_BASE=/api/v1` 构建前端；runtime `node:22-bookworm-slim` + ffmpeg/perl/ca-certificates，只拷生产依赖 + `web/dist` + 源码；`WORKDIR /app/server` 保持 `server/`、`web/` 同级，因静态托管用 `join(cwd(),'..','web','dist')` 定位；`USER node`(1000)；HEALTHCHECK 用 Node 内置 fetch 打 `/api/v1/health`）+ `docker-compose.yml`（宿主默认 8791 避开开发 8787；`/config` 只读、`/data`、`/photos` 三卷，`ARTWORKS_*` 环境变量可覆盖；uid 不匹配时 `user:` 覆盖说明写在注释里）+ `.dockerignore`（排除 node_modules/dist/本地配置/wayfinder 等）。`docker compose config` 校验通过。
- **裸机路线**：`deploy/install.sh`（依赖检查 node>=22/ffmpeg/perl → `npm ci` → 前端构建 → 生成本机配置到 `server/artworks.config.local.yaml`，已存在不覆盖 → 用户级 systemd 单元优先，root 走系统级；`--no-service`/`--config`/`--data-dir`/`--photos` 参数）+ `deploy/artworks.service` 模板（占位符由 install.sh 渲染）+ `deploy/artworks.config.example.yaml`（容器路径版，含 013 的 cache/autoRescanAfterDays 键）。`bash -n`、`systemd-analyze verify`（渲染后）通过。
- **文档**：根 `README.md` 新增「部署」节（两条路 + Tailscale 访问 + dataDir 备份 + 升级步骤）；`server/README.md` 已有挂载/NFS 相关章节。
- **验证**：本机 docker socket 被锁（Omarchy 有意不给 docker 组，等价免密 root）→ `docker compose build/up` 待用户授权后跑（解锁：`omarchy-setup-security-sudoless-docker` 后重登录，或 `omarchy-sudo-passwordless 15`，或 `sudo setfacl -m u:qdw:rw /run/docker.sock`）。**已真实验证的等价路径**：用 Node 22.23.3 直跑 `server/src/index.ts`（容器同款运行方式，Node 22.18+ 原生跑 .ts 已证实）+ 容器风格路径（root id=photos→/photos、dataDir=/data）+ 测试库**副本**：health 200、扫出 11 照片、512 缩略图 200（含 ffmpeg 抽帧视频封面 200）、打星 3→读回→归零、`diff -rq` 副本与原库无差异。前端 `VITE_API_BASE=/api/v1 npm run build` 真实构建通过。`e2e-api.mjs` 109/0。
- 已知限制（写进 compose 注释/README）：配置 `:ro` 挂载时运行期「添加项目」回写 yaml 会失败；`/photos` 直属无照片时 photoCount=0（`listPhotos` 只列直属）；ffmpeg 撑大镜像数百 MB；`/data`、`/photos` 属主须为容器内 uid 1000。
