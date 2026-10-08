# art-workspace

照片整理 web 应用（暂用代号 **art-workspace**，产品名待定）。以磁盘文件夹为真相：把一个目录映射成项目，快速挑选（星级 + 待删），待删进回收站。应用不导入、不导出、不搬动照片。

## 仓库结构（前后端模块分离）

```
contracts/     前后端契约（语言中立）：openapi.yaml —— 唯一的接口真相
web/           前端（React + TypeScript + Vite + framer-motion + shadcn/ui），纯客户端，不碰磁盘
               IA / 交互 / 数据流见 web/DESIGN.md
server/        后端（语言待定，见 wayfinder 票 005），唯一能碰磁盘的进程
wayfinder/     规划地图与决策票（见 wayfinder/map.md）
prototype/     早期单文件原型（已归档，交互结论已移植进 web/）
```

**边界规则**

- 前端只通过 `contracts/openapi.yaml` 描述的 HTTP API 访问照片；任何文件系统访问都在后端。
- 契约变更先改 `contracts/openapi.yaml`，再同步 `web/src/api/contract.ts` 与后端实现。
- 后端内部的模块划分（扫描 / 预览管线 / 标记写入 / 回收站）见 `server/README.md`。

## 功能（前端已完成的部分）

一个完整的单用户 App，左侧边栏三个页面（详见 `web/DESIGN.md`）：

| 页面 | 做什么 |
|---|---|
| 挑片 | 卡片流（滑动打星/待删）⇄ 瀑布流网格，同一份数据的两种焦距，可放大看细节 |
| 回收站 | 逻辑删除区：还原回原目录、或显式确认后真删 |
| 设置 | 根目录（多盘/移动硬盘，离线灰显）与数据源状态 |

## 开发

```bash
cd web && npm install && npm run dev        # 前端 http://localhost:5173
node tools/shot.mjs --url "http://127.0.0.1:5173/?mode=a" --out /tmp/a.png   # 精确视口截图（CDP）
```

前端默认使用内置 **mock 数据源**（浏览器内 canvas 生成假照片），无需后端即可开发交互；
接真实后端时设 `VITE_API_BASE=/api/v1`（或让 Vite 代理转发到本地后端，见 `web/vite.config.ts`）。

让后端一个进程托管前端（http://127.0.0.1:8787）：

```bash
cd web && VITE_API_BASE=/api/v1 npm run build   # 产物 web/dist；少这个环境变量会打成 mock 数据源
cd server && ./tools/dev.sh start                # 扫描 + 托管 web/dist + 提供 API，日志 /tmp/artworks-server.log
```

配置：`server/artworks.config.yaml` 是入库的默认值（全字段模板见 `server/artworks.config.example.yaml`）。
本机私有路径（例如 NAS 挂载点）写进 `server/artworks.config.local.yaml` —— 已 gitignore，`dev.sh` 会自动优先读它；
也可以用环境变量指定别的文件：`ARTWORKS_CONFIG=/path/to/cfg.yaml ./tools/dev.sh start`
（优先级：`--config=` > `ARTWORKS_CONFIG` > `artworks.config.local.yaml` > `artworks.config.yaml`）。

## 部署

两套交付物（票 012）：

**Docker**（`Dockerfile` + `docker-compose.yml`，多阶段：builder 构建前端，runtime 只留生产依赖 + `web/dist` + ffmpeg/perl，Node 22 原生跑 .ts）：

```bash
docker compose up -d --build          # 宿主端口默认 8791（避开开发服 8787），http://127.0.0.1:8791/
```

三个卷：`/config`（只读配置）、`/data`（索引/缓存/日志，**别放照片共享里**）、`/photos`（照片库，必须读写：要写 .xmp 与 .trash）。
容器内以 node(uid 1000) 运行 —— 挂载源目录属主不是 1000 时用 compose 里的 `user:` 覆盖或 `chown -R 1000:1000`。
环境变量 `ARTWORKS_CONFIG` / `ARTWORKS_DATA` / `ARTWORKS_PHOTOS` / `ARTWORKS_PORT` 可覆盖默认挂载。

**裸机**（systemd + `deploy/install.sh`）：

```bash
deploy/install.sh                    # 依赖检查 → npm ci → 构建前端 → 生成配置 → 装用户级 systemd 单元
deploy/install.sh --no-service       # 只装依赖 + 构建，不碰 systemd
deploy/install.sh --config /path/cfg.yaml --data-dir ~/.local/share/artworks --photos ~/Pictures
```

用户级单元装在 `~/.config/systemd/user/artworks.service`（注销后仍运行：`loginctl enable-linger $USER`）；
root 执行则装系统级。模板在 `deploy/artworks.service`，配置示例 `deploy/artworks.config.example.yaml`（容器路径版）。

部署要点（细节见 `server/README.md`）：Node >= 22（直跑 .ts）；`VITE_API_BASE=/api/v1` 不能少；对外访问要设 `password` 并把 `host` 改 `0.0.0.0`；网络挂载建议 NFS 直挂（gvfs 挂载在用户会话里，systemd 服务看不到，见 server/README「挂载失联」）。

**远程访问**：只打算局域网 / Tailscale，不加反代与证书（决策见 `wayfinder/tickets/005-stack-deployment.md`）。
在装了 Tailscale 的机器上把 `host` 设 `0.0.0.0`（**必须设密码**），手机/笔记本用 `http://<tailscale主机名>:8787` 访问。

**备份**：`dataDir` 一个目录就是全部可重建状态之外的东西 —— 索引、预览缓存、`tokens.json`（API 密钥）、`marks.jsonl`（标注历史）、`trash.jsonl`（回收站操作日志）。索引与预览缓存丢了可以重扫重建，但 `tokens.json` / `marks.jsonl` / `trash.jsonl` 丢了不可恢复 —— 备份策略：定时 rsync/快照 `dataDir`（排除 `previews/`、`thumbs/`）即可，体积很小。

**升级**：`git pull` → （Docker）`docker compose up -d --build`；（裸机）`deploy/install.sh`（重复跑安全）或 `cd web && VITE_API_BASE=/api/v1 npm run build && cd ../server && npm ci` → `systemctl --user restart artworks`（或 `restart artworks.service`）。数据目录不动，升级前后无需迁移。

## 测试

```bash
cd server && node tools/e2e-api.mjs         # 后端全链路（真写 .xmp、真搬回收站 —— 只对测试库跑）
cd server && node tools/e2e-cold-start.mjs  # 冷启动回归：重启后先吃索引缓存，扫描没跑完就能出列表
cd server && node tools/e2e-hung-mount.mjs  # 挂载失联回归：某个根挂死时服务照常可用（自起独立实例，端口 8788）
cd server && node tools/e2e-jobs.mjs        # 任务层：状态机 / 事件 / 取消 / 撤销 / 重启收敛（端口 8789）
cd server && node tools/e2e-annotate.mjs    # 批注任务：范围 token → 回流 → 对账 → 撤销（端口 8790）
cd server && node tools/e2e-cache.mjs       # 预览缓存策略：淘汰顺序 / 90% 停止 / 在途保护 / 自动补扫（端口 8792）
```

测试库可以用 `node server/tools/make-fixture.mjs` 现场造一份。

## 规划

当前路线与已定决策：`wayfinder/map.md`；票（tickets）在 `wayfinder/tickets/`，研究笔记在 `wayfinder/research/`。
