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
   （已定下方向：**项目 = 映射进来的一个目录**，不导入不导出，见 [ADR 0003](../../docs/adr/0003-project-is-a-mapped-directory.md)。
   所以这里要定的是映射的机制：映射表存哪、能映射几个、显示名与路径的关系、目录被拔走后怎么办）
2. 回收站：`.trash` 放项目目录内还是全局集中？如何恢复、何时真正清理、RAW+JPEG 是否成对进回收站？
3. 评分/待删状态存哪：XMP sidecar（与 Lightroom/digiKam 互通）还是仅应用数据库？文件被规则移动后状态如何跟着走？
4. 访问控制：Tailscale 内网是否还要一道密码/令牌（毕竟 app 能移动和删文件）？
5. 还有两撮小状态要落脚（票 003 交下来的）：**项目名记忆**（目录 → 项目名，用于归档时预填）与 **`devices.yaml` 别名表**（EXIF `ILCE-7M4` → 人说的 `A7M4`）。它们跟回收站、XMP 标记不是一类东西，不能塞进数据库就完事。
