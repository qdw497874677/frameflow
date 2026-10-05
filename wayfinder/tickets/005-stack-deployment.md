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
