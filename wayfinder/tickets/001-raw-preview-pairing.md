---
id: "001"
title: RAW 预览与 RAW+JPEG 配对方案
labels: [wayfinder:research]
status: open
assignee: ""
blocked-by: []
---

## Question

拍摄格式是 RAW+JPEG 双出。需要确定：

1. RAW 快速预览的服务端方案：(a) 提取 RAW 内嵌 JPEG（exiftool / libraw 等），(b) libraw 全量转码缩略图，(c) 浏览器端解码（wasm）。对比画质、速度、依赖复杂度；目标：单项目数百到数千张，缩略图网格与单张大图都要「秒开」级体验。
2. RAW+JPEG 配对识别：同名不同扩展（IMG_1234.CR2/ARW/NEF + .JPG）之外，各相机还有哪些命名差异；配对后打星、待删、归档如何成对处理、防止只动一半。
3. 参考已有实现的取舍：jshph/cull（内嵌 JPEG 提取）、catdad/raw-viewer、digiKam。

产出：技术选型建议 + 证据链接，写入 `wayfinder/research/001-raw-preview-pairing.md`。
