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

（暂无已关闭的票）

## Not yet specified

- 规则 UI 编辑器的形态（等归档规则 DSL 钉死后立原型票）
- 手机端布局与触控细节（等交互原型拿到反馈）
- 视频预览边界：浏览器原生能播的格式够不够、要不要服务端转码/抽帧缩略图
- 性能指标量化（单项目千张级？万张库的首屏与滚动）
- 开源发布配套：License 选择（注意 AGPL 项目如 Immich/PhotoPrism 的代码传染性）、README、一键部署

## Out of scope

- 预设滤镜（视觉调色/导出滤镜）——用户明确「先不做」；将来想要时重开一张新图
- 多用户、客户分享选片
- AI 自动打分 / 自动挑选
