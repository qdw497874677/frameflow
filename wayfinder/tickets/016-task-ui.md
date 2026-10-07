---
id: "016"
title: 任务页与批注页（前端 UI）
labels: [wayfinder:task]
status: closed
assignee: ""
blocked-by: []
---

## 目标

任务层后端（[014](014-jobs-core.md)）与批注往返（[015](015-annotate-dispatch.md)）已落地，前端接口层 `JobSource` 也在 `web/src/api/` 里备好了 —— 本票只做**界面**：

1. **任务页**：任务列表（按状态筛选）+ 任务详情（进度、items 快照、artifacts 链接、事件流水）。
2. **批注页 `/j?t=<token>`**：免登录（凭据就是 `?t=` 范围 token），手机上能打开；显示本任务 items 的缩略图，逐张给星级/待删，提交走 `POST /jobs/{id}/inbound`（`clientRef` 幂等，断网重发不重复）。
3. **入口**：挑片页对「当前选择集」建 `annotate` 任务（`params: {channel:'inapp', label}`）——`selection` 直接复用 store 里的 `Selection`（同一份语义，别在前端重写谓词）。

## 验收

- 任务页数据全部来自 `GET /jobs` / `GET /jobs/{id}` / `GET /jobs/{id}/events?since=`（轮询，`nextSince` 当游标）；不发 `/jobs` 之外的私有接口。
- 撤销/取消按钮按 `reversible` 与状态置灰，错误映射 409 显示成人话（「这个状态不能撤销」）。
- 批注页只用 `?t=`：缩略图 `GET /photos/{id}/thumb?size=2048&t=…`；提交后显示每条结果（成功/跳过），刷新页面能看到自己已标的项（从任务 items 读回）。
- 批注页在 390px 宽的手机视口可用（用 `tools/shot.mjs` 截图验证），触控目标不小于 44px；不需要登录、不出现管理入口。
- mock 数据源（`mockSource` 的 `JobSource` 实现）下任务页与批注页也能走通，方便离线开发与截图。
- 文案与 [GLOSSARY.md](../../GLOSSARY.md) 一致：面向用户说「任务」，不说 job。

## 不做

飞书/webhook 通道（另开票）、导出等新 kind 的 UI、通知与提醒、账号体系与权限分级。

## 进展

- 2026-10-07 开票（014/015 落地后拆出界面部分）。
- 2026-10-08 落地并验证，关闭本票（见 Resolution）。

## Resolution（2026-10-08）

**两张脸 + 一个入口**：

- 任务页（工作区 → 任务）：左列表（`all|active|done|ended` 客户端筛、每 4s 拉 `GET /jobs?limit=100`、默认选最新一条或 `?job=` 深链、进度条）+ 右详情（`GET /jobs/{id}` + `GET /jobs/{id}/events?since=` 每 2.5s 用 `nextSince` 当游标增量拉、进度、取消/撤销按状态与 `reversible` 置灰、产物链接可复制/打开、items 快照网格、事件流水倒序）。服务端的中文 409 直接显示给人看。手机先给列表，点进去才有详情（顶栏 `aria-label="回到列表"` 返回）。
- 批注页（`/j?t=<范围 token>`）：`main.tsx` 按 pathname 分流，整页独立于 App 外壳（没有侧栏、目录树、管理入口），免登录 —— 凭据就是 URL 里那条 token。缩略图 `<img src="…?size=512&t=…">`（图像标签带不上 header）；点开看大图（2048）逐张给星级/待删，每点一下立刻 `POST /jobs/{id}/inbound`，`clientRef = <photoId>:<stars>:<del>` 让同一意图重发幂等、不同意图是新 ref；发不出去的进队列、顶部「N 条没发出去 + 重发」；刷新时从任务 items 读回已经标过的项。
- 入口：挑片页底部「派发批注」→ 对话框（批注人 + `mode:'plan'` 预演张数与前 12 张缩略图）→ 派发。`selection` 直接复用 store 里那份（前端不重写谓词），补两件事：绑当前项目、选择集为空时用「眼前这批」的 id 清单。

**过程中改到的服务端**：范围 token 新增放行 `GET /jobs/{id}`，但只放行 token 里那一个 id（列表/事件/取消/撤销一律不放行）—— 批注页刷新要能读回 items；`e2e-annotate` 补了断言（94/0）。

**两个实现教训**（都写进了代码注释）：

- `POST /jobs`（apply）是异步的：立刻回 `state:'queued'`、`artifacts: []`，链接由 handler 稍后才落进 artifacts —— 对话框必须盯着 `GET /jobs/{id}` 直到链接出现（否则用户拿到一条空产物，第一版就是这样）。
- 手机不能一进任务页就自动选中最新一条：列表被顶掉、人不知道自己在哪。宽屏才默认选中。

**验证**：真后端全链路（派发 7 张 → 链接 → 批注页标 ★4 → 挑片页计数变 1 → 任务页进度 1/7 + 事件流水 `写入标注 (stars:0,del:false → stars:4,del:false)`、`by = link:外部批注人`）；mock 数据源同样走通（预置 `demo` 任务 + `mock-` 前缀 token）；390px 手机视口下批注页网格 2 列、无横向溢出、星按钮与看大图按钮 44×44；`npx tsc --noEmit` 干净；`VITE_API_BASE=/api/v1 npm run build` 通过。

**没做**（按票面）：出站通道的真投递（v1 只有 `inapp` 链接）、其他 kind 的 UI、通知提醒、权限分级。

**提交后的复核（2026-10-07，reviewer 15 条）**：修了 9 条真问题，其中两条是「看起来好了、其实没好」：

- 死链页对 401 失效：`AuthRequiredError` 的文案是「需要登录」，`/401|403|失效|未认证/` 匹配不到 —— 认证开着的部署里，过期/失效链接永远停在「加载失败 + 重试」。改成 `instanceof AuthRequiredError` 判。
- 回流整批无条件置「已记录」：`POST /jobs/{id}/inbound` 除异常外恒 200，单项失败在 `results[].ok` 里 —— 现在失败项落 `failed` 并进重发队列（`e2e-annotate` 补了「一张被扔进回收站」的单项失败断言）。
- 服务端：已取消的任务 `undo` 会在**回滚完标注之后**因 `cancelled → cancelled` 非法迁移抛 409（标注白回滚）；范围 token 的越界判定只看路径不看方法，且 `decodeURIComponent` 遇 `%` 会 500。
- 前端：事件轮询改串行循环（慢响应时同一批事件会追加两次、`nextSince` 回退）、切任务时清详情、派发防重入、artifacts 轮询随卸载停止且读不到时报错、`<Button asChild disabled>` 管不到里面的 `<a>`、星按钮补 `aria-pressed`、术语统一「批注人」（`link:<批注人>`）。
