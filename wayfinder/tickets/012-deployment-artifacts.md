---
id: "012"
title: 部署交付物：Docker 镜像 + compose + systemd 单元 + install.sh
labels: [wayfinder:task]
status: open
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
