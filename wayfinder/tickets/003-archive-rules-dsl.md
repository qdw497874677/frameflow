---
id: "003"
title: 归档规则 DSL
labels: [wayfinder:grilling]
status: closed
assignee: "qdw"
blocked-by: []
---

## Question

钉死归档规则的语言：条件（扩展名/文件类型、相机、镜头、日期、星级、照片 vs 视频）→ 动作（移动/复制）→ 目标目录模板（变量如 `{YYYY}/{MM}/{设备}/{类型}/{原始|修改后}`）。

必须能自然表达用户的现实结构：项目目录（一次旅行/导入）→ 按设备 → 照片|视频 → 原始|修改后。

同时回答：「修改后」目录 app 管不管（app 只管原始文件，修改后由编辑软件产出？）；多条规则命中同一文件时的优先级；YAML schema 草案。

（规则 UI 编辑器在 DSL 钉死后另立原型票，当前在图的 Not yet specified 里。）

## Resolution

归档规则的语言钉死在 [contracts/rules.md](../../contracts/rules.md)（规范本体）。一句话版本：

- **YAML + 单括号模板**：`dest: "{root}/{project}/{device}/照片/{variant}"`，日期用 `{date:YYYY-MM}`；未知变量/字段一律拒绝整份文件，不静默忽略。
- **判定**：规则有序，**首条命中即停**；同一规则内不同条件是 AND、同一条件写数组是 OR；**待删的照片永不参与归档**。
- **动作**：只有 `move` 与 `skip`（`skip` 用来保护一类照片不被后面的规则搬走）。v1 没有 copy —— 复制会产生两份真相。
- **条件（v1）**：`kind` / `stars`（区间）/ `marked` / `camera` / `lens` / `taken`（日期区间）/ `folder`（当前目录 glob）。文件名模式与光圈 ISO 等留 v1.1。
- **`{project}`**：一个 plan 只解析一次；手动指定优先并**记住在该目录上**，否则取批内拍摄日跨度（单日 `2026-03-05`，跨日 `2026-03-05_2026-03-08`）。目录名推断降级为普通变量 `{folder:1}`。
- **冲突**：默认追加序号 `-1`，可配 `skip`，**永不覆盖**；执行前必须先预演，执行后落移动日志（撤销按钮留 v1.1）。
- **成组**：`pair: true` 时移动的最小单位是「主文件 + 影子文件（`{stem}.xmp` / `{stem}.{ext}.xmp` / `.aae`·`.dop`·`.pp3`）」，组内原子；RAW 与 JPEG 同属一组。
- **日期来源**：EXIF `DateTimeOriginal` → 文件名日期 → `mtime`，预演里标出来源；相机当地时间当墙上时间用，**不做时区换算**。
- **别名表**（独立 `devices.yaml`）：EXIF 是 `ILCE-7M4`，规则里写 `A7M4`；后端统一应用，页面与 `{device}` 都用别名。
- **「修改后」**：app 永不产出它，规则只把它当输入目录。

问答里说「`stars: 0` 就表示未打星」，落地时收紧成：`stars: 0` 是**非法写法**（0 不是下限），未打星用 `marked: false` 或 `stars: { eq: 0 }` —— 避免「0 = 不过滤」与「0 = 未打星」两种理解打架。

### 决策记录

- 为什么首条命中、为什么永不覆盖、为什么成组原子：[ADR 0002](../../docs/adr/0002-archive-rule-semantics.md)
- 为什么 app 不产出「修改后」、不建导入式库：[ADR 0001](../../docs/adr/0001-filesystem-is-truth.md)
- 术语（根目录/项目/变体/组/影子文件/待删/预演/别名）：[GLOSSARY.md](../../GLOSSARY.md)

### 行业依据

- Rapid Photo Downloader（最成熟的「按规则归档」）**没有文本语法**，是图形化勾选 Name/图像编号/日期/ISO/相机的组合器；它会一起改名 XMP，且遵循 Adobe 规范 `IMG_1234.xmp`（不是 `IMG_1234.ARW.xmp`） —— 影子文件的写法与我方 `pair` 定义一致。
- Immich 用 `{{y}}/{{MM}}-{{dd}}/{{filename}}` 这种 mustache 模板，**重名追加序号、绝不覆盖** —— 冲突策略与我方 `rename` 一致。

### 未决

- `devices.yaml` 与「项目名记忆」存在哪，归票 004（状态存哪）。
- 规则编辑 UI（含别名表编辑面）：已立票 007。
