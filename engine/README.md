# frameflow-film：基于物理的胶片模拟引擎

一个独立进程运行的 C++20 引擎。它从光谱层面模拟“负片 → 印放 → 相纸 → 扫描”这条链路。FrameFlow 服务端会把它当作子进程启动，双方通过 stdin/stdout 上的帧协议通信。所有数据和算法的来源都记录在 [PROVENANCE.md](PROVENANCE.md) 中（这是净室实现，不含任何 GPL 代码）。

## 构建与测试

```bash
tools/fetch_stocks.sh          # 下载厂商数据表 → 校验 sha256 → 数字化 → 生成 data/stocks
cmake -S . -B build -G Ninja   # 可加 -DFFE_NATIVE=ON 针对本机 CPU 优化（产物不可移植）
cmake --build build
ctest --test-dir build --output-on-failure
```

运行：`build/frameflow-film --data data/stocks [--threads N]`。

调试或验证用的客户端：

```bash
python3 tools/ffe_client.py --engine build/frameflow-film --data data/stocks render in.jpg out.jpg --compare side.jpg
```

## 协议（版本 1）

协议的基本单位是一帧，格式为 `"FFE1" | u32 LE header_len | JSON header | u32 LE payload_len | payload`，其中 header 不超过 1 MB，payload 不超过 1 GB。每个请求对应一个响应，响应原样带回请求中的 `id`。

| op | 请求 | 响应 |
|---|---|---|
| `hello` | – | `engine, version, protocol, threads` |
| `list_stocks` | – | `stocks: [{id, name, inspiredBy, kind}]` |
| `bake_lut` | `stock, paper?, size(2..129), params?` | 返回 payload：f32 类型的 size³×3 个值，sRGB 编码，**红色变化最快**（即 .cube 的顺序） |
| `render` | `stock, paper?, width, height, format(rgb8\|rgb16 LE), params?`，payload 为像素数据 | 返回同格式的像素数据 |
| `shutdown` | – | `ok`，然后退出 |

请求出错时返回 `{ok:false, id, error:{code, message}}`，`code` 为 `bad_request`、`unknown_op`、`unknown_stock` 或 `internal` 之一。如果协议本身出错（如帧损坏），引擎会以退出码 4 退出，由宿主负责重启。

`params` 的取值（括号内为默认值和范围）：

- `exposureEv`：0，范围 [−6, 6]
- `sceneKelvin`：5500
- `printerKelvin`：3200
- `viewingKelvin`：6504，以上三个色温的范围都是 [2000, 12000]
- `printGrey`：0.18，范围 [0.05, 0.5]
- `dirStrength`：1，范围 [0, 2]
- `scanBlackPoint`：true
- `inputGamma`：1.2，范围 [1, 2]。输入是“显示参考”的（相机 JPEG/sRGB），在灰以下按 1/γ 撤销 SDR 参考 OOTF（ITU-R BT.2390），灰以上约 1 EV 内平滑回到斜率 1，白点基本不动；1 = 输入已是场景线性（M1 行为）
- `cameraFlare`：0.01，范围 [0, 0.1]。镜头杂散光（ISO 18844），按场景白的比例均匀加到胶片曝光上，测光保持 18% 灰不变

### 仅 `render` 的空间参数（M2）

这些效果依赖邻域像素，**不进 LUT**（`bake_lut` 忽略它们，LUT 预览不含这些效果）；任何一个打开时 `render` 走整帧路径（约 50 字节/像素的工作内存）。

- `filmFormatMm`：36，范围 [8, 300]。画幅长边（135 = 36 mm），决定像素在胶片上的尺寸 = 长边 mm ×1000 / 长边像素
- `dirDiffusionUm`：0（关），范围 [0, 100]。DIR 抑制剂扩散长度（胶片上的高斯 σ，µm），产生边缘效应（Mackie 线、锐度）；均匀区域不变
- `grain`：0（关），范围 [0, 4]。颗粒大小倍数（乘在各层等效染料云半径上，1 ≈ ISO 400 彩负）。Newson 等 2017 的布尔模型：每层显影染料按覆盖率 u = 染料量 / 最大染料量 生成，方差随密度变化，均值不变
- `grainSeed`：0，范围 [0, 2³²−1]。颗粒只取决于（种子、层、像素位置），与线程数无关；同一种子同一尺寸结果逐字节一致

- `halation`：0（关），范围 [0, 1]。片基反射回乳剂的曝光比例（红层权重 1、绿 0.25、蓝 0）；能量守恒，均匀区域不变，只在强高光周围产生偏红的光晕
- `halationRadiusMm`：0.25，范围 [0.02, 2]。光晕在胶片上的高斯 σ（mm）

**LUT 预览没有颗粒（也没有边缘效应、光晕）**：3D LUT 是逐像素映射，表达不了随机、依赖邻域的效果。要看颗粒，用 `render` 渲染原尺寸或 100% 裁切；服务端目前只烘焙 LUT，接入整帧 `render` 是后续工作。

## 模型（M1）

1. **光谱上采样：** 先把线性 sRGB 转成反射率，用的是三条光滑基光谱（和为 1、取值在 [0, 1]）。它们在场景光源下能复现 Bradford 适应后的 sRGB 原色，由 ADMM 二次规划在运行时求出。
2. **输入与杂散光：** 显示参考输入先按 `inputGamma` 估回场景光，再在各层曝光量上加 `cameraFlare`。
3. **相机曝光：** 反射率 × 场景光源 × 负片各层光谱感光度，得到各层曝光量；18% 灰落在数据表的 Log H Ref 上。
3. **显影：** 按 Status M 特性曲线，用牛顿法反解出各层染料量；再加入 DIR 层间抑制（只作用于偏离中性的部分）。M2：6 个抑制系数改为在 −2…+2 EV 灰阶上加权最小二乘拟合；整帧渲染时抑制剂可按 `dirDiffusionUm` 扩散，并带自抑制项（边缘效应）。
4. **印放：** 负片透射率 = 10^−(Dmin + Σ 染料量·光谱密度)，乘以 3200 K 灯光和相纸感光度。各层的印放光量会自动平衡，使 18% 灰印成中性的 `printGrey`。
5. **相纸：** 由 Status A 曲线得到相纸染料量，再算出反射光谱。
6. **观看/扫描：** 反射光谱 × 观看光源，经 CMF 得到 XYZ；把相纸白 Bradford 适应到 D65 白、相纸 D-max 映射为黑，最后输出线性 sRGB。

当前胶片数据：`portrait400`（负片）和 `premierpaper`（相纸）。
