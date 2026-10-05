---
id: "003"
title: 归档规则 DSL
labels: [wayfinder:grilling]
status: open
assignee: "qdw"
blocked-by: []
---

## Question

钉死归档规则的语言：条件（扩展名/文件类型、相机、镜头、日期、星级、照片 vs 视频）→ 动作（移动/复制）→ 目标目录模板（变量如 `{YYYY}/{MM}/{设备}/{类型}/{原始|修改后}`）。

必须能自然表达用户的现实结构：项目目录（一次旅行/导入）→ 按设备 → 照片|视频 → 原始|修改后。

同时回答：「修改后」目录 app 管不管（app 只管原始文件，修改后由编辑软件产出？）；多条规则命中同一文件时的优先级；YAML schema 草案。

（规则 UI 编辑器在 DSL 钉死后另立原型票，当前在图的 Not yet specified 里。）
