---
id: "005"
title: 技术栈与部署形态
labels: [wayfinder:grilling]
status: open
assignee: ""
blocked-by: ["001"]
---

## Question

技术栈与部署形态（受「RAW 预览与 RAW+JPEG 配对方案」结论约束）：

- 语言/框架选型（服务端 + 前端）
- 单二进制 vs Docker 镜像
- 缩略图缓存的位置、生成时机与失效策略
- 大批量移动文件的事务性：中途断电/断网不能产生「半个移动」（尤其 RAW+JPEG 成对移动）
- 单用户简单认证方案

产出：一张可执行的选型决定。

## 进展

- 2026-09：**语言已定 —— TypeScript（Node 22 LTS+）**。用户 m01889「可以 用ts 一些功能要支持后续通过模块化的方式集成」；决定与理由见 [ADR 0005](../../docs/adr/0005-typescript-backend.md)（陈述：与前端同语言共享契约类型、`sharp`/`exiftool-vendored` 覆盖图像活、AI 走外部服务时无生态劣势、需要时用 sidecar 逃生）。
- 仍待定（本票余下部分）：部署形态（裸机 systemd / Docker / 反代）、缩略图缓存的位置与失效策略、大批量移动的事务性（断电不产生半个移动）、认证面（会话 cookie + Bearer API token + 链接 token 三种凭据的分工与存放）。
