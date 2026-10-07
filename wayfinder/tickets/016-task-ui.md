---
id: "016"
title: 任务页与批注页（前端 UI）
labels: [wayfinder:task]
status: open
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
