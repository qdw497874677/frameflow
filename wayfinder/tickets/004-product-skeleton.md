---
id: "004"
title: 产品骨架决策
labels: [wayfinder:grilling]
status: open
assignee: ""
blocked-by: []
---

## Question

产品骨架的几个连锁决策：

1. 项目发现：直接浏览整个文件系统树，还是「注册项目根目录」后只看注册过的项目？
2. 回收站：`.trash` 放项目目录内还是全局集中？如何恢复、何时真正清理、RAW+JPEG 是否成对进回收站？
3. 评分/待删状态存哪：XMP sidecar（与 Lightroom/digiKam 互通）还是仅应用数据库？文件被规则移动后状态如何跟着走？
4. 访问控制：Tailscale 内网是否还要一道密码/令牌（毕竟 app 能移动和删文件）？
