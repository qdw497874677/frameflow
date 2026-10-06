---
labels: [wayfinder:map]
title: 照片整理 web 应用
status: open
---

# 照片整理 web 应用 · Wayfinder 地图

## Destination

一个开源、自托管的照片整理 web 应用：把磁盘上的一个目录**映射**成一个项目来浏览（不导入、不导出、不搬动），用「星级 + 待删」做快速且有趣的**标注**（含 Tinder 式滑动），待删进产品回收站；标注之后可以触发**任务**（导出、删除、将来的滤镜处理，以及把批注任务推送到飞书等外部渠道再回流）；**AI 可以参与选片** —— 既能作为执行者被我们调用，也能作为客户端自己来取活干。单用户，家中部署，Tailscale 网内任何设备可访问。

## Notes

- 定位：自用优先，但按可发布的开源产品标准做（部署要简单）
- 文件夹即真相：直接浏览/操作磁盘目录，不搞导入式媒体库
- **项目 = 映射进来的一个磁盘目录**：不导入、不导出、不搬动；原文件只会被写标记（XMP）与回收站操作碰到（[ADR 0003](../docs/adr/0003-project-is-a-mapped-directory.md)）
- 文件夹由用户自己先整理好：应用只做映射 → 扫描 → 标注（星级/待删）→ 回收站，不做任何归位决策
- **核心模型：库 + 标注 + 任务**（扫描/浏览/标注是状态层；删除/导出/处理/推送批注是动作层任务）——见 [docs/core-model.md](../docs/core-model.md) 与 [ADR 0004](../docs/adr/0004-jobs-and-events.md)
- 骨架纪律：先预演再执行 · 一切写磁盘的动作都是任务且有 manifest · 选择集是可序列化的谓词 · 要事件日志不要事件总线 · 要任务不要工作流引擎
- **后端 = TypeScript（Node）**：与前端同语言、共享契约类型；能力以「注册表 + manifest」装配（每能力一文件、只依赖 core、声明副作用等级），新增能力前端零改动（[ADR 0005](../docs/adr/0005-typescript-backend.md)）
- **AI 不是特殊通道，是最挑剔的客户端**：同一套 API、三种凭据（浏览器 cookie / Bearer token / 范围受限链接 token）；AI 可被我们调用（annotate 任务），也可自己来取活干（MCP/HTTP）（[core-model §11](../docs/core-model.md)）
- 外部模块（插件）与内置模块同一 manifest 契约；模块不能直接碰磁盘，只能经 core 的接口
- 拍摄格式：RAW + JPEG 双出，配对成对处理
- **库在 NAS 上（网络共享）**：缩略图与索引缓存在服务端本地（不写回共享）；扫描要增量（按 mtime+size 判脏）；回收站必须与被删文件同共享（`rename` 只在共享内原子）；跨共享的移动=复制+删，不能当原子操作
- 删除 = 逻辑删除（产品管理的回收站，可恢复）
- 交互要求：便捷、高效、有趣；触屏滑动 + 键盘流都要
- 用户现实目录习惯：项目目录（一次旅行/一次导入）→ 按设备分 → 照片|视频分 → 原始|修改后
- tracker：本地 markdown，约定见 [TRACKER.md](TRACKER.md)
- 会话开工先读 grilling / domain-modeling 技能；原型票用 prototype 技能；research 票由子代理调用 research 技能解决

## Decisions so far

- [RAW 预览与 RAW+JPEG 配对方案](tickets/001-raw-preview-pairing.md)：服务端分层预览管线（外部 JPEG 优先→内嵌提取→LibRaw 兑底）；同目录同名配对；pair 为一等实体，打星/待删/归档成对原子处理，星级写 XMP。详见 [研究报告](research/001-raw-preview-pairing.md)
- [挑选交互原型（星级+滑动）](tickets/002-culling-interaction-prototype.md)：一份数据两种焦距（卡片流 ⇄ 网格，变焦飞行切换）；右滑加星·下压连加·左滑待删，星与待删互斥；键盘 1–5/0/←→/X/空格/Ctrl+Z；双击放大 2.5× 带小地图；RAW+JPEG 始终成对。已演化为正式前端 `web/`
- [叠卡与滑动手势的可借鉴开源实现](tickets/006-swipe-stack-libs.md)：不整体换库，按 Swing 的物理参数模型升级手写叠卡（拖动耦合后排 + 速度参与的弹簧松手 + 交接曲线连续）；Swiper `effect:'cards'` 作为 B 计划。详见 [研究报告](research/006-swipe-stack-options.md)


## Not yet specified

- 手机端布局与触控细节（等交互原型拿到反馈）
- 视频播放与转码边界：**缩略图已定** —— 服务端 ffmpeg 抽一帧当封面（`preview: video_poster`，缓存在本机缩略图缓存，不写回共享），播放交给浏览器原生；仍未定：播放器控件、以及浏览器原生播不了的格式要不要服务端转码
- 性能指标量化（单项目千张级？万张库的首屏与滚动）
- 「偏软 / 跑焦」角标的值从哪来（现在前端拿的是假数据）：靠 EXIF、靠服务端图像分析，还是干脆删掉这个概念
- 导出：把挑好的照片交到别的目录 / 别的工具（用户 m01572「后续再做」）——形态未定（复制？链接？给外部工具一个清单？）；已按任务层设计占位（[docs/core-model.md](../docs/core-model.md) §8）
- 滤镜 / 处理：作为导出任务的 recipe 参数，而不是独立管线（现在不做）
- 开源发布配套：License 选择（注意 AGPL 项目如 Immich/PhotoPrism 的代码传染性）、README、一键部署
- AI 接入面的具体形态：先做 pull 还是 push、结果是否走「建议」层、MCP 是否必做、token 范围、领取机制 → [票 009](tickets/009-ai-access.md)
- 插件扩展面：内置模块与第三方插件的分界、插件能贡献什么、权限等级、加载与隔离 → [票 010](tickets/010-plugins.md)；其中「虚拟目录 / Alcedo 式项目节点路径」是**默认关闭的可选插件**

## Out of scope

- 素材导入（LR 式工作流）—— 用户判定多余：照片已经在磁盘上按项目分好了目录，导入要多一份与来源对账的状态（「导入后删来源」还引入不可逆的破坏性动作）。理由见 [ADR 0003](../docs/adr/0003-project-is-a-mapped-directory.md)；导出不在这里（推迟到后续，见 Not yet specified）
- 归档 / 规则引擎（条件匹配 → 目标目录模板 → 先预演再原子移动）—— 用户判定不需要（m01565 问「归档是什么，是不是可以简化掉」→ m01572「文件夹我可以先整理好」）：文件夹自己先整理，应用只标注与删除。曾经实现到可演示，已整体删除；规范草稿与语义留在 [contracts/rules.md](../contracts/rules.md) 与 [ADR 0002](../docs/adr/0002-archive-rule-semantics.md)（已标为取代）；将来要做导出/归位时重开一张新图
- 预设滤镜（视觉调色/导出滤镜）——用户明确「先不做」；将来想要时重开一张新图
- 多用户、客户分享选片
