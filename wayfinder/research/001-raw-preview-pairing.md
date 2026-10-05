# 调研报告 001：RAW 快速预览与 RAW+JPEG 配对方案

- 票：`wayfinder/tickets/001-raw-preview-pairing.md`（status: open）
- 结论适用范围：自托管、单用户照片整理 web 应用（见 `wayfinder/map.md`），单项目数百～数千张，缩略图网格与单张大图均需「秒开」级体验，拍摄格式为 RAW+JPEG 双出。
- 方法：只采信一手信源（官方文档、相机说明书、源码仓库、维护者邮件列表/GitHub 讨论），二手博客仅作实践佐证并标注。检索执行于 2026-06（报告中注明各信源年份）。

---

## TL;DR 推荐方案

1. **预览采用分层管线，全部在服务端做，浏览器端不做 wasm 解码**：
   - 第 0 层（配对优先）：RAW+JPEG 成对时直接用**外部 JPEG 原文件**做网格与单图预览（外拍 JPEG 质量高于内嵌预览，photo.stackexchange 实测 q95 vs q81；FastRawViewer 默认在有外部 JPEG 时隐藏内嵌 JPEG，因其「通常分辨率更好」）。
   - 第 1 层（无配对时）：**提取 RAW 内嵌 JPEG**（exiftool `-b` 提取，或自研容器扫描）+ sharp/libvips 缩放 + 磁盘缓存。这是 cull（Rust）「千张亚秒」与 Immich「prefer embedded preview」选项共同验证的路线。
   - 第 2 层（兜底，按需）：内嵌预览缺失/过小（部分机型 CR3/ARW 内嵌仅 1620×1080）时，用 **LibRaw 系解码**（Rust: rawler；Python: rawpy；Node: sharp/libvips 的 RAW loader）按需生成，异步后台跑，不阻塞网格。
2. **配对识别规则：同目录 + 同 basename（大小写不敏感的 stem）+ 一端是 RAW 扩展、另一端是 JPG/JPEG 扩展**。这是 DCF 标准命名（`DSCxxxxx` + 三字母扩展）下所有取证软件（FastRawViewer、darktable、Lightroom、digiKam、cull）的共同假设；darktable 维护者明确拒绝跨目录同名配对。
3. **成对处理语义：pair 为一等实体**。打星/待删/归档以 pair 为原子单位落盘（两文件一起移动/标记），星级写入共享的 XMP sidecar（cull 与 FastRawViewer 的做法）或双写 XMP；待删 = 逻辑删除进产品回收站（FastRawViewer 的 `_Rejected` 文件夹 + 双重确认是成熟先例）。

---

## 一、RAW 快速预览三方案对比

### 方案 A：服务端提取 RAW 内嵌 JPEG（推荐主力）

**原理**：所有现代相机在拍摄时都会在 RAW 容器内烧入一张 JPEG 预览（相机屏幕回放用的就是它）。提取它只是「读容器结构 + 拷贝字节段」，无需去马赛克，无渲染管线。

- cull README（原文）：*"Every RAW file already contains a full-resolution JPEG preview baked in by your camera. Most software ignores this and decodes the entire RAW file. `cull` extracts these embedded previews directly — no decoding, no rendering pipeline, no waiting."*（https://github.com/jshph/cull）
- 内嵌 JPEG 的容器位置因格式而异：TIFF 系（CR2/NEF/ARW/DNG/PEF/ORF/RW2）在文件目录指向的 image directory；CR3 在 ISO 基媒体容器的独立 box；RAF 直接内嵌（https://www.getkepla.com/blog/embedded-jpeg-preview-inside-raw-files）。

**工具与提取命令（exiftool，事实上的标准）**：

- 通用清单：`exiftool -preview:all file` 列出全部内嵌图；全部导出：`exiftool -a -b -W %d%f_%t%-c.%s -preview:all DIR`。
- 各格式内嵌图标签**不统一**（需要按格式选择或用复合标签）：
  - CR3：`-JpgFromRaw` 是其中最大的 JPG（photools 论坛，Mario，2023：https://www.photools.com/community/index.php/topic,12922.0.html）
  - NEF：同时有 `ThumbnailTIFF`、`JpgFromRaw`、`PreviewImage`（Affinity 论坛，NotMyFault，2024：https://forum.affinity.serif.com/index.php?%2Ftopic%2F225884-extracting-the-jpg-from-a-raw-file-can-it-be-done%2F=）
  - RAF（富士）：**没有** `JpgFromRaw`，只有 `PreviewImage`（约 900KB 全尺寸）+ `ThumbnailImage`（约 8KB）——Phil Harvey 本人在 exiftool 论坛确认（https://exiftool.org/forum/index.php?topic=11400.0）
  - CR2：损坏卡恢复案例中用 `exiftool -b -previewimage -ext cr2 -w _preview.jpg .` 批量导出，178 读/168 成功，恢复出的预览为 5760×3840 全尺寸（https://exiftool.org/forum/index.php?topic=4712.0）
  - 复合标签 `BigImage` = 当前文件可用的最大预览图，可作跨格式统一入口（Phil Harvey：「BigImage is a Composite tag」，https://exiftool.org/forum/index.php?topic=5393.0；topic 11400 中 `BigImage` 与 RAF 的 914562 字节 PreviewImage 等值）
- **注意**：exiftool.org 论坛服务器不稳定（Phil 公告 DreamHost 过载，https://exiftool.org/forum/index.php?topic=4328.0），部署不依赖其可用性。

**速度证据**：

| 场景 | 数字 | 信源 |
|---|---|---|
| exiftool 读元数据（Node 绑定 exiftool-vendored，stay_open + 4 进程，Linux i3，3011 文件） | **4.2 ms/文件**（同机单进程 9.0ms；旧 exiftool npm 包 28.4ms） | https://unpkg.com/exiftool-vendored@2.8.0/README.md |
| exiftool 读元数据（Windows，i7，默认串行） | 118.6 ms/文件（约 8.4 文件/秒） | pigallery2 讨论 #1031：https://github.com/bpatrik/pigallery2/discussions/1031 |
| Rust 版 exiftool 解析器（i7-8700K，194 文件） | 共 81ms（24.6 MB/s），单文件 ~1–2ms | https://docs.rs/crate/exiftool-rs/latest/source/perf/last-run.txt |
| 10000 个 CR3 批量（Phil Harvey 本机，本地快盘，一条命令） | **约 30–36 秒**（≈3–4ms/文件） | https://github.com/exiftool/exiftool/issues/384 |
| 158 个 CR3 在 SD 卡上直读 | 57s（exiftool 13.44）→ 21.7s（13.47 加 `-fast` 补丁后）；根因是 I/O，不是解析 | 同上 |
| cull（自研容器扫描 + 后台线程提取，Rust） | 官方宣称「打开数千张 RAW 亚秒级」 | https://github.com/jshph/cull |
| raw-viewer（Electron + exiftool 进程） | 维护者实测元数据「只有几毫秒」，真正瓶颈曾是**把全尺寸图当缩略图**，用 sharp 缩放修复 | https://github.com/catdad/raw-viewer/issues/69 |

研究者推断（非信源原文）：二进制预览提取比纯元数据读取多一次大块字节拷贝，耗时主要受磁盘 I/O 支配——本地 SSD 上单文件仍为个位数毫秒量级，SD 卡/网络盘上会退化到数百毫秒；缩略图网格应只做一次提取 + 缓存，绝不每请求重提。

**画质证据**：

- 内嵌 JPEG 质量低于外拍 JPEG：同一张 RAW+JPEG，ImageMagick 量测外部 JPEG quality≈95，内嵌≈81，字节数约 1/3（https://photo.stackexchange.com/questions/77793/）。
- **内嵌预览分辨率随机型差异极大**（纯 PHP 容器扫描库对真实相机文件的实测表，https://github.com/ronan-develop/raw-preview-extractor）：
  - Canon 5D/5D2/5D4 CR2：2496×1664 ～ **6720×4480 全尺寸**（1.6–2MB）
  - Nikon D750 NEF：**6016×4016 全尺寸**
  - **Canon EOS R / RP CR3：仅 1620×1080**（228–328KB）
  - **Sony α7（2013）ARW：仅 1616×1080**（460KB）
  - iPhone 12 Pro DNG：4032×3024
  - 极老机型（Nikon D1H 2001、CHDK 生成的 DNG）**完全没有 JPEG 预览**（报 PreviewNotFoundException 是正确行为）
  - 独立佐证：EyeEm 工程师编译 dcraw→wasm 时发现「某些提取出的预览 JPG 只有 400px 宽」（https://eric-schaefer.com/blog/2020-01-10-compiling-dcraw-to-webassembly/）
- 结论：内嵌预览**适合挑选（构图/表情/时机），不适合检验高光找回/阴影细节**——FastRawViewer 官方博客与 Selekt 摘选文章均持此立场（https://www.fastrawviewer.com/blog/most-obvious-reasons-to-look-at-RAW、https://www.selekt.photos/blog/raw-vs-jpeg-culling）。对本应用（culling 场景）足够。

**依赖/部署**：

- exiftool：Perl 单文件工具，各发行版/平台均有包；语言绑定成熟（Node: exiftool-vendored（自带二进制）；Rust: exiftool-rs；Python: PyExifTool/-stay_open 模式）。瓶颈是它「做得太多 + Perl」（Phil Harvey 原话，issue #384）。
- 自研容器扫描（cull 路线）：cull 的 Cargo.toml **没有任何 RAW 解码依赖**（不用 rawler/libraw），仅用 `image`（jpeg 特性）解 JPEG + `roxmltree` 处理 XMP，约 3000 行 Rust 实现 CR2/CR3/NEF/ARW/RAF/DNG/ORF/RW2/PEF/SRW 全部格式（Cargo.toml：https://raw.githubusercontent.com/jshph/cull/master/Cargo.toml）。说明 TIFF/CR3 容器层扫描是可控的小工程量。
- **已知陷阱**：提取出的内嵌 JPEG 常缺 `Orientation` EXIF，直接送 sharp 会横竖颠倒——Immich 专设 PR 从原文件 exif 信息回填方向（https://github.com/immich-app/immich/pull/13948）。

### 方案 B：LibRaw 全量解码转缩略图（推荐兜底/按需）

**能力与覆盖**：

- LibRaw 是 dcraw 的维护性延续，digiKam 官方文档称其支持「超过 1000 种 RAW 文件格式」，digiKam 的 RAW 转换即基于 LibRaw（https://docs.digikam.org/en/supported_materials/image_formats.html、https://docs.digikam.org/en/batch_queue/raw_converter.html）。
- 相机覆盖列表：LibRaw 0.22 / 202502 快照均覆盖 Canon CR2/CR3、Nikon NEF、Sony ARW、Fujifilm RAF、DNG 等（个别格式需编译期开 GPRSDK/DNGSDK/X3FTOOLS/6BY9RPI 选项才全量支持）（https://www.libraw.org/supported-cameras）。
- **LibRaw 也能只提内嵌预览**：`unpack_thumb()` 把最大预览原样读进内存（多数相机是 JPEG 原字节，少数老机型是 RGB 位图），`unpack_thumb_ex(i)` 取第 i 张，`dcraw_make_mem_thumb()`/`dcraw_thumb_writer()` 输出（https://www.libraw.org/docs/API-CXX.html）。即「提取内嵌 JPEG」不必引独立 exiftool，libraw 绑定即可完成（quality：JPEG as-is，无重编码）。

**速度证据（全解码是数量级的慢）**：

| 场景 | 数字 | 信源 |
|---|---|---|
| LibRaw `unpack()`（仅解包，不做去马赛克），Canon 6D2 24MP CR2，i3-7100U 笔记本 | **1.31 s/张** | https://www.libraw.org/node/2513 |
| Fujifilm X-T2 RAF（X-Trans），Mac mini i7：半尺寸 `-h` vs 全尺寸去马赛克 | **0.99s vs 1m13s**（Markesteijn 三遍插值单线程） | https://www.libraw.org/node/2353 |
| Canon RAW（Huffman 压缩）解码相对慢；RawSpeed 比 LibRaw 快（可经 LibRaw 间接用） | 定性 | https://www.libraw.org/node/2105 |
| digiKam 编辑器选项：8-bit BT.709「快而简单」模式 vs 16-bit 线性（更准更慢）+ 去马赛克算法分档（Bilinear 最快 / AAHD 质量最好） | 定性 | https://docs.digikam.org/en/setup_application/editor_settings.html |

→ 研究者推断：24MP 常规 Bayer 在家用服务器上全解码约 0.3–1.5s/张，X-Trans（富士 RAF）全解码可达数十秒；**数千张网格同步全解码不可行**，只能做按需/后台任务。

**画质/正确性风险（Web 服务端渲染 RAW 的真实教训）**：

- Immich 最初用 sharp（libvips/libraw 管线）渲染 RAW 缩略图，用户反馈「对比度差、高光发暗」，社区提案改用 exiftool 提内嵌预览；维护者结论：**两条路线并存**——sharp 渲染对很多 RAW 是好的，但很多 RAW 没有高分辨率内嵌预览，于是加「优先用内嵌预览」选项（https://github.com/immich-app/immich/discussions/5758，选项已上线）。
- Immich 早期 CR2/RAF 缩略图直接损坏/黑图，根因在 libvips 的 RAW 加载路径（如 libvips/libvips#3460），一度 blocked on libvips/imagemagick 更新（https://github.com/immich-app/immich/pull/2834）。
- libvips 对「全尺寸内嵌 JPEG 预览」的选取历史上有过滤问题（libvias 讨论 #5001：https://github.com/libvips/libvips/discussions/5001）。
- → 走方案 B 时**必须钉住可复现的库版本**，并把「渲染结果 ≠ 相机 JPEG」当成产品预期管理。

**语言绑定**：Python `rawpy`（letmaik 维护，跟 LibRaw 0.22.1，预编译轮子：https://github.com/letmaik/rawpy）；Rust `rawler`（dnglab 项目，同时给像素+元数据，crates.io 14 万+下载，API 未到 SemVer 稳定：https://crates.io/crates/rawler）；Node 生态 sharp/libvips（Immich 路线）。

### 方案 C：浏览器端 wasm 解码（不推荐）

现有实现（均为小项目，非工业强度）：

- `ybouane/LibRaw-Wasm`：LibRaw 的 Emscripten 构建 + Web Workers，支持 CR2/NEF/ARW/DNG 等解码（https://github.com/ybouane/LibRaw-Wasm）
- `discere-os/LibRaw.wasm`：SIMD 优化的 LibRaw 移植（2025，fork，0 star）（https://github.com/discere-os/LibRaw.wasm）
- `nhebling/dcraw-wasm`：dcraw.c 编译为 wasm，可提取元数据**和内嵌 JPEG 缩略图**（https://github.com/nhebling/dcraw-wasm）
- 先例博客（EyeEm，2020）：dcraw→wasm 在浏览器提取内嵌缩略图全流程可行（https://eric-schaefer.com/blog/2020-01-10-compiling-dcraw-to-webassembly/）

不推荐理由（研究者推断 + 间接证据）：

1. 浏览器要解码必须先把 20–60MB 的 RAW **完整下载**到客户端（Tailscale 内网带宽通常 10–100Mbps，一张 30MB 需 3–25s），「秒开」直接失败；服务端方案只传几百 KB 的缩略图。
2. 全解码速度继承 LibRaw 原生基准（0.3–1.5s/张起，X-Trans 更糟），wasm 通常再打折扣；这些库都没有发布性能基准（见「缺失证据」）。
3. 维护成熟度：仓库星数个位数，无长期维护承诺；而服务端 exiftool/LibRaw 都是十年级维护的生态。
4. 唯一说得通的用法是「离线/无服务端」场景（EyeEm 的诉求），与本应用（自托管 web）不符。

### 三方案对比总表

| 维度 | A 内嵌 JPEG 提取 | B LibRaw 全解码 | C 浏览器 wasm |
|---|---|---|---|
| 网格速度（数千张） | ✅ 毫秒级/文件 + 缓存后零成本 | ❌ 0.3–70s/文件，只能异步后台 | ❌ 还要先传完整 RAW |
| 单张大图秒开 | ✅（配对时直接用外拍 JPEG；未配对用内嵌，个别机型偏小） | ⚠️ 按需解码 0.3–1.5s+（X-Trans 更慢） | ❌ 下载 + 解码双重延迟 |
| 画质 | 挑选够用；≠ RAW 实际可恢复数据；分辨率随机型（CR3/老 ARW 仅 ~1620×1080） | ✅ 最忠实（能看恢复能力） | 同 B（渲染管线还更简陋） |
| 格式覆盖 | 现代相机普遍有；极老机型无预览 | ✅ 最广（1000+ 格式） | 取决于移植的库 |
| 依赖复杂度 | exiftool（单工具）或自研扫描（cull 证明 ~3k 行）；**也要处理 Orientation 回填** | 需编译/绑定 rawpy/rawler/sharp；渲染正确性历史坑多 | 前端体积 + 无成熟库 |
| 部署复杂度 | 低（容器多装一个 exiftool） | 中（native 依赖、版本钉死） | 前端工程复杂 |

---

## 二、推荐预览管线（服务端）

```
请求预览(pair 或 file)
 ├─ pair 存在外部 JPEG ──────────► 直接服务该 JPEG（网格尺寸由 sharp 缩放缓存）
 ├─ 无 pair：查内嵌提取缓存 ────► 命中即返回
 ├─ 未缓存：exiftool -b 提取最大预览（BigImage/按格式）──► sharp 缩放成
 │     thumbnail(网格, ~512px webp/jpeg) + preview(单图, ~2048px) 两档 ──► 落盘缓存
 └─ 提取失败或预览 < 阈值(如 <1600px 且用户要放大)：
       后台队列 rawler/rawpy/libraw 半尺寸解码 → 生成 preview 档 → 缓存
       （期间先返回已有缩略档，不阻塞）
```

- 两档尺寸 + 302 重定向回退是 Immich 的成熟做法（thumbnail/preview/fullsize 三档，缩放后加载 fullsize，未生成时 302 回 preview：https://github.com/immich-app/immich/pull/14446）。
- Orientation：提取的内嵌 JPEG 缺方向 EXIF 时，从原 RAW 的 exif 元数据回填再交给 sharp（Immich PR #13948 的教训）。
- 缓存失效：以 (path, mtime, size) 为键，简单可靠。
- 目标核对：数百～数千张项目首屏 = 读缓存或首次批量提取（exiftool 批处理 ~3–10ms/文件本地盘，1000 张 ≈ 3–10s 一次性成本，之后常驻缓存）；单张秒开 = 配对 JPEG 或已缓存 preview；未配对 RAW 首次放大最坏 ~1–2s（解码兜底）。

---

## 三、RAW+JPEG 配对识别

### 3.1 命名规律（一手：相机说明书与行业标准）

**根规则：DCF 标准**（Design rule for Camera File system，JEITA）要求文件名为 `DSCxxxxx` + 三位扩展、存于 `DCIM/100xxxxx` 目录（Sony 官方转述：*"Image file names must be named DSCxxxxx.JPG"*，https://www.sony.com/electronics/support/articles/00023619）。**RAW+JPEG 双出时两张照片是同一帧的两种编码，共享同一文件号**——这是全行业软件配对规则的事实基础。

各厂商差异（均不影响「同 basename」这一配对规则，因为差异只出现在前缀/大小写，且**同一对内两文件一致**）：

| 厂商 | 文件名形态 | RAW/JPEG 扩展 | 信源 |
|---|---|---|---|
| Nikon | `DSC_nnnn.xxx`；**Adobe RGB 时前缀变 `_DSCnnnn`**（下划线移位） | NEF / JPG / TIF | https://onlinemanual.nikonimglib.com/zf/en/psm_file_naming_110.html、https://onlinemanual.nikonimglib.com/z7_z6/en/09_menu_guide_03_03.html |
| Canon | `IMG_nnnn`；**每文件夹编号到 9999 后建新文件夹重新从 0001 开始**（官方明确提醒多文件夹下载到同一处会重名） | CR2/CR3 / JPG | https://www.canon-europe.com/pro/infobank/file-numbering-and-naming/ |
| Sony | `DSC`+5 位数字，可自定义前 3 字符（不得以下划线开头）；文件号 Series/Reset 两种 | ARW / JPG | https://helpguide.sony.net/dsc/2510/v1/en/contents/0601_file_folder_settings.html、RAW&JPEG 说明 https://helpguide.sony.net/dsc/1750/v1/en/contents/TP0001552912.html |
| Fujifilm | sRGB `DSCFnnnn`；Adobe RGB `_DSFnnnn` | RAF / JPG | https://app.fujifilm-dsc.com/en/manual/gfx50s-ii/menu_setup/save_data_set-up/index.html |

**未发现任何厂商在 RAW+JPEG 双出时给两文件不同 basename**（检索相机官方文档未获反例；此为「未找到反例」而非「证明不存在」，见缺失证据）。

### 3.2 软件界的配对规则取证

| 软件 | 配对规则 | 成对行为 | 信源 |
|---|---|---|---|
| **FastRawViewer** | 同名 RAW+JPEG 合并显示；**JPEG 扩展必须是 `.JPG` 或 `.jpg`**；同目录多个同名 RAW（不同扩展）时，JPEG 配给**字母序最早**的 RAW 扩展 | 显示为同一影像的两种表征；**移动其一另一个跟随**；`_Rejected` 待删文件夹带「NN RAW、MM RAW+JPEG」统计；可把同一 XMP 块同时写入 JPEG；同名 CR2+DNG 会争同一个 `filename.XMP` sidecar（命名冲突被显式讨论） | 手册 https://www.fastrawviewer.com/usermanual17、设置页 https://www.fastrawviewer.com/usermanual17/program-settings、v2 PDF https://updates.fastrawviewer.com/data/FastRawViewer2-Manual-ENG.pdf |
| **darktable** | **导入时自动分组：同 basename 不同扩展**（`IMG_1234.CR2` + `IMG_1234.JPG`）；**仅在两文件同目录时生效**——维护者明确：「不能假设文件系统上分居两地的同名文件是同一组，不是所有人都给照片起唯一名字」，据此更新了文档 | 组有 leader（RAW 优先，新版本以 RAW 为代表）；「copy & import」重命名会破坏配对（issue #10085）；社区 lua 脚本 `jpg_group_leader.lua` 可把 leader 换成 JPG | 手册 https://docs.darktable.org/usermanual/development/en/lighttable/digital-asset-management/grouping/、https://github.com/darktable-org/darktable/issues/8824、#10085、#9503、#3998 |
| **Lightroom Classic** | 偏好项 **「Treat JPEG files next to raw files as separate photos」默认关闭**：同名相邻 JPEG 默认视为 RAW 的一部分、不单独入库 | 开启后两文件并排独立显示 | https://asktimgrey.com/2025/05/05/importing-rawjpeg/、https://lifeafterphotoshop.com/lightroom-raw-plus-jpeg-pairs/ |
| **digiKam** | 手动批量：全选 → 右键 Group → **Group Selected by Filename**（「同名不同文件类型」归一组）；导入时**无自动分组**（2021 邮件列表确认，bug tracker 有愿望单） | 自动按文件名分组时**取组内最小的文件做 leading item（预览加载更快）**；组内打星**两文件都带星**，但过滤命令只会选出其中一个（用户实测反馈） | https://docs.digikam.org/en/main_window/image_view.html、https://mail.kde.org/pipermail/digikam-users/2021-January/031645.html、2020-01 邮件 https://mail.kde.org/pipermail/digikam-users/2020-January/030081.html |
| **cull** | README 原文：**「RAW/JPEG pairs with a shared basename also share an XMP sidecar and a Cull decision」**——同名对共享一个 sidecar 和一个挑选决定 | Pick/Reject 写 `xmpDM:good` XMP（Lightroom 实测序列化格式），原子替换 | https://github.com/jshph/cull |
| **Immich** | RAW+JPEG 自动 stack 在讨论时为 planned（feature #2479），方向是「stack 后展示 JPEG」；缩略图已有「优先用内嵌预览」选项 | stack 后缩略图/展示用 JPEG | https://github.com/immich-app/immich/discussions/5758 |

### 3.3 推荐的配对检测规则（综合取证）

1. **配对域 = 单个目录**（darktable #8824 维护者立场；Canon 9999 换文件夹重号也要求不跨目录配）。
2. **stem（去扩展名的文件名）精确相等，大小写不敏感**；扩展名一端 ∈ RAW 集（cr2/cr3/nef/arf/…/arw/raf/dng/orf/rw2/pef/srw…），另一端 ∈ {jpg, jpeg}（FastRawViewer 只认 `.JPG/.jpg`；darktable 用大小写不敏感的扩展比较，#3998 维护者：「requires the filenames to be the same except the extension」）。
3. **一个 stem 有多个 RAW 时**：优先与「字母序最早的 RAW 扩展」配（FRV 规则），或把整个 stem 视为一个多重组（更通用）。
4. **同名 + JPEG 侧还出现 `.XMP` sidecar**：sidecar 属于整组（cull/FRV 语义），不要重复建。
5. **不自动配的边界情况**（显式留给用户决定或按可配置规则）：用户改名后只剩一侧、`IMG_1234 (1).JPG` 这类复制后缀、扩展名 `.JPEG` 长形式（相机不产生，多为人工文件——可配对但建议默认关）。
6. 防御：配对结果只在索引层成立，磁盘真相仍是文件本身——每次扫描重建 pair 表，`mtime` 变化触发重算。

---

## 四、打星 / 待删 / 归档的成对语义（设计建议 + 先例）

| 操作 | 建议语义 | 先例依据 |
|---|---|---|
| 打星 | 星级属于 **pair**，UI 上一次打星、数据层写两处（共享 XMP sidecar（cull/FRV）或 RAW+JPEG 各写（digiKam 组内两文件都带星））。对外交换格式用 XMP `xmp:Rating`；若要被 Lightroom/C1 识别 Pick/Reject，cull 实测序列化是 `xmpDM:good` | cull README（xmpDM:good 与 LR 互验）、FRV 手册（可把同一 XMP 块嵌入 JPEG；sidecar 与内嵌 XMP 冲突时按 `xmp:MetadataDate` 取新）、digiKam 邮件（两文件都带星、过滤只出一个） |
| 待删 | 待删标记同样落在 pair 上：**一次拒绝 = 两个文件都进产品回收站**（逻辑删除，可恢复——与 map.md 的产品回收站定位一致）。成熟先例：FRV 不允许直接删，而是移入 `_Rejected` 子文件夹；清空前显示「NN RAW / MM RAW+JPEG」统计 + 不可关闭的二次确认（还解释了为什么不用系统回收站：网络盘/移动介质上系统回收站不可靠） | FRV v2 手册 `_Rejected` 章节 |
| 归档/移动 | **成对原子移动**：移动其一，另一个跟随（FRV 原文行为）。实现上把 pair 当作移动事务的单位，失败回滚或补偿，UI 显示「已移动 2 文件」。darktable #10085 的教训：任何「复制时改名」的归档规则都会**破坏后续重新扫描的配对**——归档规则若改名，必须整对同步改、保持 stem 相同 | FRV 手册「When you move a file from the RAW + JPEG pair to another folder, the other file follows」、darktable #10085 |
| 只动一半的防御 | ① pair 为主键的所有写操作走同一事务路径；② 扫描时发现「孤儿」（有 pair 记录但只剩一文件、或星级 sidecar 只覆盖一文件）要在 UI 显式提示；③ 回收站恢复时按 pair 恢复 | 研究者综合设计建议（cull 的共享 sidecar 天然避免半写；digiKam 用户抱怨过组内过滤不一致） |

---

## 五、已有实现取舍分析

### jshph/cull（Rust 桌面 culling，MIT）
- 路线：**纯内嵌 JPEG 提取 + 自研容器扫描**。Cargo.toml 无 rawler/libraw，仅 `image`(jpeg)+`roxmltree`；「~3000 行 Rust、4.5MB 单二进制、无运行时依赖」；后台线程提取 + 异步 EXIF；「数千张亚秒」。
- XMP：按命名空间解析、属性边界补丁、原子替换；决定用 `xmpDM:good`（绿/红标签映射 C1 与 LR）。
- **对本项目的启示**：容器扫描自研可行（工作量可控）；「不动原文件字节，只写 sidecar」是安全基线；同名 RAW+JPEG 共享 sidecar 的语义简单有效。
- 取舍：它是原生 GPU 桌面应用；web 应用不能照搬渲染层，但其数据层（提取 + sidecar）几乎可整体移植。

### catdad/raw-viewer（Electron 桌面）
- 路线：**exiftool 常驻进程（fetch 脚本自带二进制）+ dcraw 9.28.1 按平台预编译兜底 + exifr 快速 EXIF + sharp 缩放 + trash 删进系统回收站**（package.json：https://github.com/catdad/raw-viewer/blob/master/package.json；lib/image.js：sharp 优先、canvas 兜底的缩放与旋转）。
- 关键教训（issue #69）：元数据读取「几毫秒」不是瓶颈，**用全尺寸图当缩略图才是**——修复即引入 sharp 缩略。
- 对本项目启示：exiftool 常驻进程模式（-stay_open）在服务端同样适用；「待删进回收站」的产品语义它用系统 trash，自托管 web 用产品内回收站更合理。

### digiKam（KDE DAM）
- RAW 渲染基于 LibRaw（1000+ 格式），编辑器分 8-bit 快速 / 16-bit 线性两档，去马赛克算法可选（质量换速度）——即**全解码是它的编辑路径，不是浏览路径**；浏览缩略图另走预览缓存。
- 配对 = 手动「Group by Filename」（同名不同类型），自动分组导入不存在（2021 现状；bug tracker 有愿望）；组打星会传播到两文件，但过滤表现不一致（用户困惑点 = 我们要避免的）。
- 对本项目启示：不要复制它的「手动分组」交互——我们的用户目录天然成对，自动配对 + 手动纠正更好。

### 补充先例
- **Immich**（自托管照片库，AGPL）：sharp/libvips 渲染 RAW 出过对比度/高光问题 → 加「优先内嵌预览」选项（exiftool 提取）；内嵌预览缺 Orientation 出过旋转 bug；CR2/RAF 缩略图曾被 libvips bug 弄坏；最终形态 thumbnail/preview/fullsize 三档 + 302 回退。这是与本应用最接近的**服务端 web** 先例，其踩坑清单应直接进入我们的验收用例。
- **FastRawViewer**（商业，专做 RAW culling）：其 RAW+JPEG 配对语义（配对显示、成对移动、_Rejected、XMP 双写）是本票第 2/3 问最完整的行业答案。

---

## 六、风险与缺失证据

**矛盾/张力**（未消解，如实记录）：
1. 内嵌预览「够不够看」存在立场分歧：cull/FRV 默认拿它做挑选；FRV 官方博客同时警告「内嵌预览 ≠ RAW 实际可恢复的高光/阴影」（卖自家全解码的说辞，但技术论点成立）；Immich 维护者则指出「很多 RAW 内嵌预览分辨率不高」。→ 处理：分层管线天然调和：预览优先、放大兜底解码。
2. exiftool 性能结论跨平台差异巨大（Linux ~4ms/文件 vs Windows ~119ms/文件）——部署环境是 Linux/容器，取乐观值但需自测。

**缺失证据（未能验证）**：
1. 浏览器 wasm RAW 解码（LibRaw-Wasm/dcraw-wasm）**无公开性能基准**；「比服务端慢」是基于下载体积 + wasm 一般开销的推断，非实测。
2. exiftool **提取二进制预览**（非元数据）的专项耗时基准未找到公开数据；引用的数字是元数据读取与 I/O 场景，需在真实照片目录自测（预期同数量级，见推断标注）。
3. 「所有厂商 RAW+JPEG 双出 basename 一致」基于 DCF 标准 + Nikon/Canon/Sony/Fuji 手册 + 五家软件行为一致，**未逐一核对 Panasonic/Olympus/OM/Pentax/Leica/Ricoh 官方手册**；若用户拥有这些机身，建议用真实文件验证。
4. Immich RAW+JPEG 自动 stack 的当前实现状态（讨论时为 planned，feature #2479）未核实是否已发布。
5. cull「数千张亚秒」为项目方自我宣称，无第三方复测。

**对本项目的特有风险**：
- 用户机型若以 CR3 或早期 ARW 为主，内嵌预览仅 1620×1080，单图放大体验依赖兜底解码层——必须实现第 2 层，不能只做提取。
- 内嵌 JPEG 的色彩空间是相机渲染结果（Picture Style/胶片模拟），与最终 RAW 成片观感有差——culling 场景可接受，需在产品文案中说明。

---

## 七、信源清单（保留）

**方案 A（内嵌提取）**
- cull（jshph）README + Cargo.toml — 内嵌提取路线的完整自证：https://github.com/jshph/cull 、https://raw.githubusercontent.com/jshph/cull/master/Cargo.toml
- exiftool 官方文档（-b/-preview:all/-fast 等）：https://exiftool.org/exiftool_pod.html
- exiftool 论坛 RAF 预览标签（Phil Harvey）：https://exiftool.org/forum/index.php?topic=11400.0 ；BigImage 复合标签：topic=5393.0 ；CR2 批量恢复：topic=4712.0
- photools 论坛 CR3 -JpgFromRaw 实例：https://www.photools.com/community/index.php/topic,12922.0.html
- 内嵌预览分辨率实测表（PHP 容器扫描库）：https://github.com/ronan-develop/raw-preview-extractor
- 内嵌 vs 外拍 JPEG 质量实测：https://photo.stackexchange.com/questions/77793/
- exiftool 速度：https://github.com/exiftool/exiftool/issues/384 、https://unpkg.com/exiftool-vendored@2.8.0/README.md 、https://docs.rs/crate/exiftool-rs/latest/source/perf/last-run.txt 、https://github.com/bpatrik/pigallery2/discussions/1031

**方案 B（LibRaw）**
- LibRaw C++ API（unpack_thumb/make_mem_thumb）：https://www.libraw.org/docs/API-CXX.html
- LibRaw 性能贴：node/2513（24MP unpack 1.31s）、node/2353（X-Trans 半幅 1s vs 全幅 73s）、node/2105（Canon Huffman/RawSpeed）
- LibRaw 支持相机列表：https://www.libraw.org/supported-cameras
- rawpy：https://github.com/letmaik/rawpy ；rawler：https://crates.io/crates/rawler
- digiKam RAW 转换/编辑器设置：https://docs.digikam.org/en/batch_queue/raw_converter.html 、https://docs.digikam.org/en/setup_application/editor_settings.html

**方案 C（wasm）**
- https://github.com/ybouane/LibRaw-Wasm 、https://github.com/discere-os/LibRaw.wasm 、https://github.com/nhebling/dcraw-wasm 、https://eric-schaefer.com/blog/2020-01-10-compiling-dcraw-to-webassembly/

**配对识别与成对语义**
- DCF 标准（Sony 转述）：https://www.sony.com/electronics/support/articles/00023619
- Nikon 文件命名：https://onlinemanual.nikonimglib.com/zf/en/psm_file_naming_110.html 、https://onlinemanual.nikonimglib.com/z7_z6/en/09_menu_guide_03_03.html
- Canon 编号与文件夹：https://www.canon-europe.com/pro/infobank/file-numbering-and-naming/
- Fujifilm 命名：https://app.fujifilm-dsc.com/en/manual/gfx50s-ii/menu_setup/save_data_set-up/index.html
- Sony 文件/文件夹设置：https://helpguide.sony.net/dsc/2510/v1/en/contents/0601_file_folder_settings.html ；RAW&JPEG：https://helpguide.sony.net/dsc/1750/v1/en/contents/TP0001552912.html
- FastRawViewer 手册与设置（配对/移动/_Rejected/XMP）：https://www.fastrawviewer.com/usermanual17 、https://www.fastrawviewer.com/usermanual17/program-settings 、https://updates.fastrawviewer.com/data/FastRawViewer2-Manual-ENG.pdf
- darktable 分组文档 + issues #8824（仅同目录）、#10085（改名破坏配对）、#3998、#9503：https://docs.darktable.org/usermanual/development/en/lighttable/digital-asset-management/grouping/
- Lightroom RAW+JPEG 偏好：https://asktimgrey.com/2025/05/05/importing-rawjpeg/ 、https://lifeafterphotoshop.com/lightroom-raw-plus-jpeg-pairs/
- digiKam 分组文档 + 邮件列表（无自动导入分组、组内星级行为）：https://docs.digikam.org/en/main_window/image_view.html 、https://mail.kde.org/pipermail/digikam-users/2021-January/031645.html 、https://mail.kde.org/pipermail/digikam-users/2020-January/030081.html
- catdad/raw-viewer（package.json、lib/image.js、issue #69）：https://github.com/catdad/raw-viewer

**Web 服务端先例（Immich）**
- 内嵌预览选项讨论（sharp 渲染画质问题）：https://github.com/immich-app/immich/discussions/5758
- 内嵌预览缺 Orientation 修复：https://github.com/immich-app/immich/pull/13948
- RAW 格式支持与 libvips bug：https://github.com/immich-app/immich/pull/2834
- 三档预览 + 302 回退：https://github.com/immich-app/immich/pull/14446

**剔除/降级的信源**
- docs.rs 上无关的 `cull 0.12.0`（rashida-thorne/cull，"jq for HTML"）——与 jshph/cull 同名不同项目，剔除
- Selekt/Kepla 等商业博客——观点正确但为二手，仅作佐证不作为规则依据
- 9degreesbelow exiftool 命令页——内容与官方 pod 重复，降级
