---
labels: [wayfinder:map]
title: 照片整理 web 应用
status: open
---

# 照片整理 web 应用 · Wayfinder 地图

## Destination

一个开源、自托管的照片整理 web 应用：以磁盘文件夹为真相浏览拍摄成果，用「星级 + 待删」做快速且有趣的挑选（含 Tinder 式滑动），待删进产品回收站，再按规则（文件类型、设备 EXIF 等）把选中的照片归档到目标目录。单用户，家中部署，Tailscale 网内任何设备可访问。

## Notes

- 定位：自用优先，但按可发布的开源产品标准做（部署要简单）
- 文件夹即真相：直接浏览/操作磁盘目录，不搞导入式媒体库
- 拍摄格式：RAW + JPEG 双出，配对成对处理
- 删除 = 逻辑删除（产品管理的回收站，可恢复）
- 交互要求：便捷、高效、有趣；触屏滑动 + 键盘流都要
- 用户现实目录习惯（规则引擎必须能表达）：项目目录（一次旅行/一次导入）→ 按设备分 → 照片|视频分 → 原始|修改后
- tracker：本地 markdown，约定见 [TRACKER.md](TRACKER.md)
- 会话开工先读 grilling / domain-modeling 技能；原型票用 prototype 技能；research 票由子代理调用 research 技能解决

## Decisions so far

- [RAW 预览与 RAW+JPEG 配对方案](tickets/001-raw-preview-pairing.md)：服务端分层预览管线（外部 JPEG 优先→内嵌提取→LibRaw 兑底）；同目录同名配对；pair 为一等实体，打星/待删/归档成对原子处理，星级写 XMP。详见 [研究报告](research/001-raw-preview-pairing.md)
- [挑选交互原型（星级+滑动）](tickets/002-culling-interaction-prototype.md)：一份数据两种焦距（卡片流 ⇄ 网格，变焦飞行切换）；右滑加星·下压连加·左滑待删，星与待删互斥；键盘 1–5/0/←→/X/空格/Ctrl+Z；双击放大 2.5× 带小地图；RAW+JPEG 始终成对。已演化为正式前端 `web/`
- [叠卡与滑动手势的可借鉴开源实现](tickets/006-swipe-stack-libs.md)：不整体换库，按 Swing 的物理参数模型升级手写叠卡（拖动耦合后排 + 速度参与的弹簧松手 + 交接曲线连续）；Swiper `effect:'cards'` 作为 B 计划。详见 [研究报告](research/006-swipe-stack-options.md)
- [归档规则 DSL](tickets/003-archive-rules-dsl.md)：YAML + `{token}` 模板（`{root}/{project}/{device}/{kind}/{variant}`、`{date:YYYY-MM}`）；规则有序·**首条命中即停**；同规则内 AND、同字段数组 OR；动作只有 move/skip；冲突追序号·**永不覆盖**；移动最小单位是「组」（主文件 + 影子文件）且组内原子；`{project}` 整批解析一次（手动指定优先并记住，否则用拍摄日跨度）；日期 EXIF→文件名→mtime、当地时间不换算；EXIF 型号用别名表翻译。规范见 [contracts/rules.md](contracts/rules.md)，理由见 [ADR 0002](docs/adr/0002-archive-rule-semantics.md)

## Not yet specified

- 手机端布局与触控细节（等交互原型拿到反馈）
- 视频预览边界：浏览器原生能播的格式够不够、要不要服务端转码/抽帧缩略图
- 性能指标量化（单项目千张级？万张库的首屏与滚动）
- 「偏软 / 跑焦」角标的值从哪来（现在前端拿的是假数据）：靠 EXIF、靠服务端图像分析，还是干脆删掉这个概念
- 开源发布配套：License 选择（注意 AGPL 项目如 Immich/PhotoPrism 的代码传染性）、README、一键部署

## Out of scope

- 预设滤镜（视觉调色/导出滤镜）——用户明确「先不做」；将来想要时重开一张新图
- 多用户、客户分享选片
- AI 自动打分 / 自动挑选
