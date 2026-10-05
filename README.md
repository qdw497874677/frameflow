# art-workspace

照片整理 web 应用（暂用代号 **art-workspace**，产品名待定）。以磁盘文件夹为真相，快速挑选（星级 + 待删），再按规则把选中的照片归档到目标目录。

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
- 后端内部的模块划分（扫描 / 预览管线 / 标记写入 / 归档移动 / 回收站）见 `server/README.md`。

## 功能（前端已完成的部分）

一个完整的单用户 App，左侧边栏五个页面（详见 `web/DESIGN.md`）：

| 页面 | 做什么 |
|---|---|
| 挑片 | 卡片流（滑动打星/待删）⇄ 瀑布流网格，同一份数据的两种焦距，可放大看细节 |
| 回收站 | 逻辑删除区：还原回原目录、或显式确认后真删 |
| 归档 | **先预演再执行**：按规则算出每张的目标目录，确认后原子移动 |
| 规则 | 条件 + 目标目录模板（YAML 持久化），编辑 UI 待 wayfinder 票 003 |
| 设置 | 根目录（多盘/移动硬盘，离线灰显）与数据源状态 |

## 开发

```bash
cd web && npm install && npm run dev        # 前端 http://localhost:5173
node tools/shot.mjs --url "http://127.0.0.1:5173/?mode=a" --out /tmp/a.png   # 精确视口截图（CDP）
```

前端默认使用内置 **mock 数据源**（浏览器内 canvas 生成假照片），无需后端即可开发交互；
接真实后端时设 `VITE_API_BASE=/api/v1`（或让 Vite 代理转发到本地后端，见 `web/vite.config.ts`）。

## 规划

当前路线与已定决策：`wayfinder/map.md`；票（tickets）在 `wayfinder/tickets/`，研究笔记在 `wayfinder/research/`。
