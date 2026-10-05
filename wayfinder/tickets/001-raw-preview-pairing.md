---
id: "001"
title: RAW 预览与 RAW+JPEG 配对方案
labels: [wayfinder:research]
status: closed
assignee: "researcher"
blocked-by: []
---

## Question

拍摄格式是 RAW+JPEG 双出。需要确定：

1. RAW 快速预览的服务端方案：(a) 提取 RAW 内嵌 JPEG（exiftool / libraw 等），(b) libraw 全量转码缩略图，(c) 浏览器端解码（wasm）。对比画质、速度、依赖复杂度；目标：单项目数百到数千张，缩略图网格与单张大图都要「秒开」级体验。
2. RAW+JPEG 配对识别：同名不同扩展（IMG_1234.CR2/ARW/NEF + .JPG）之外，各相机还有哪些命名差异；配对后打星、待删、归档如何成对处理、防止只动一半。
3. 参考已有实现的取舍：jshph/cull（内嵌 JPEG 提取）、catdad/raw-viewer、digiKam。

产出：技术选型建议 + 证据链接，写入 `wayfinder/research/001-raw-preview-pairing.md`。

## Resolution

完整报告：[research/001-raw-preview-pairing.md](../research/001-raw-preview-pairing.md)（含全部信源链接与性能数字）。结论：

1. **预览 = 服务端分层管线，浏览器不做 wasm 解码**：
   - 第 0 层：RAW+JPEG 成对时直接用外部 JPEG 原文件（画质优于内嵌预览，q95 vs q81）；
   - 第 1 层：无配对时 exiftool `-b`（或自研容器扫描，cull 证明约 3k 行即可）提取内嵌 JPEG + sharp/libvips 缩放，落盘两档缓存（网格 ~512px / 单图 ~2048px，键=path+mtime+size）；
   - 第 2 层：内嵌预览缺失或 <1600px 时，后台队列用 LibRaw 系（rawler/rawpy）半尺寸解码兑底，不阻塞网格。已知坑：内嵌 JPEG 常缺 Orientation，需从原文件 EXIF 回填（Immich PR #13948 教训）。
2. **配对规则**：同目录 + 大小写不敏感的 stem 精确相等 + 一端 RAW 扩展、另一端 jpg/jpeg（DCF 标准，FRV/darktable/LR/digiKam/cull 五家一致）；多 RAW 同 stem 时配字母序最早扩展；不跨目录配对；每次扫描重建 pair 表。
3. **成对语义**：pair 是一等实体，打星/待删/归档都以 pair 为原子单位。星级写共享 XMP sidecar（cull 用 `xmpDM:good`，与 LR/C1 互通）；待删 = 两文件一起进产品回收站（FRV `_Rejected` 先例）；移动时成对原子移动，归档规则若改名必须整对同步改保持 stem 相同（darktable #10085 教训）。
