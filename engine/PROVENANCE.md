# 来源记录（PROVENANCE）

FrameFlow 胶片引擎（`engine/`）是**净室实现**：只依据公开文献和厂商公开数据从头编写。
**没有**打开、阅读、复制或移植任何 GPL 项目的源码或数据，包括 SpektraLab、spektrafilm、
spectral_film_lut、RawTherapee、darktable。SpektraLab 只作为“这类引擎可以做成独立进程”的
产品思路参考，引擎的代码、数据和参数都不来自它。

数据下载日期：2026-10-27。以下按组件列出全部来源。

## 1. 厂商数据（不入库，构建时下载）

| 文件 | 文档 | URL | sha256 |
|---|---|---|---|
| `e4050_portra_400.pdf` | Kodak Professional Portra 400 Film, Technical Data E-4050（2016 年 2 月） | https://imaging.kodakalaris.com/sites/default/files/files/products/e4050_portra_400.pdf | `e83ac6775d37832a4cb466892a3e1cf4c88917a6ee93384e59d6924b1cd97e3a` |
| `e4070_endura_premier.pdf` | Kodak Professional Endura Premier Paper, Technical Data E-4070（PDF 修改日期 2017-12） | https://business.kodakmoments.com/sites/default/files/files/products/e4070.pdf | `94ead00f26a4bbf8ce1a991ff73add049514e38f32d6e88aa7a8a1e3e2d7982e` |
| `e4046_ektar_100.pdf` | Kodak Professional Ektar 100 Film, Technical Data E-4046（2016 年 2 月） | https://imaging.kodakalaris.com/sites/default/files/files/resources/e4046_ektar_100.pdf | `e39971d16dc8679fb92742a229c237acde5b0dddb0428a708f8ad68d7a1d5590` |
| `e4051_Portra_160.pdf` | Kodak Professional Portra 160 Film, Technical Data E-4051（2016 年 2 月） | https://imaging.kodakalaris.com/sites/default/files/files/resources/e4051_Portra_160.pdf | `a635048fc5e578747868684ff5a98fa2a6582a5d4542dd4ba2e132bc06d951c0` |
| `e4040_portra_800.pdf` | Kodak Professional Portra 800 Film, Technical Data E-4040（2025 年 1 月） | https://www.kodakprofessional.com/sites/default/files/2025-07/e4040.pdf | `13581198dffa01c5a2a38ab87d96a73cf2e2755b6514d55c65206fe621a60b5a` |
| `E7022_Gold_200.pdf` | Kodak Gold 200 Film, Technical Data E-7022（2016 年 2 月） | https://imaging.kodakalaris.com/sites/default/files/files/resources/E7022_Gold_200.pdf | `9f19012f258b5e61be9b043c554483f01d338d0a8aff28163cb4ef6d7ddbe7df` |
| `f4017_TriX.pdf` | Kodak Professional Tri-X 320 and 400 Films, Technical Data F-4017（2016 年 2 月） | https://imaging.kodakalaris.com/sites/default/files/files/resources/f4017_TriX.pdf | `51d738f4f996c98716d153bab75e41d0359637a18ea49f9be52062652b0b27d2` |
| `e7020_ektacolor_edge.pdf` | Kodak Ektacolor Edge Paper, Technical Data E-7020（相纸：特性曲线第 3 页、光谱灵敏度第 4 页、染料光谱密度第 3 页） | https://business.kodakmoments.com/sites/default/files/files/products/e7020.pdf | `5c6ae49b0f1a85474acb9a57aa7933179997d087f7c1176f084602ac6e881fa0` |

**使用条款。** 我们于 2026-10-27 查阅了 Kodak Alaris 的网站条款
（https://www.kodakalaris.com/legal/website-terms-and-conditions 及其 FAQ）。条款允许出于非商业、
个人目的或为了解其产品而使用网站内容，但**禁止**复制、再发布或以电子形式分发网站内容；FAQ 允许
“非商业的研究、教育”用途。所以本仓库（公开仓库）采取的做法是：

- **不提交** PDF，也**不提交**从 PDF 数字化出来的曲线和生成的胶片数据文件（`engine/data/` 已在 `.gitignore` 中）。
- 只提交工具和元数据：下载地址、sha256、坐标轴标定点、路径编号和拟合方法。
- 构建时由 `engine/tools/fetch_stocks.sh` 从原地址下载，先校验 sha256，再在本地生成数据。
- 胶片 ID 使用中性名称（`portrait400`、`portrait160`、`portrait800`、`vivid100`、`golden200`、`classicbw400`、`premierpaper`、`edgepaper`），不使用 Kodak 商标作为产品名；`inspiredBy` 字段只用于说明数据来源。
- **待确认：** 在商业产品或分发的镜像（含 Docker 镜像中打包生成的数据）里使用这些衍生数据之前，需要法务确认，或取得 Kodak Alaris 的书面许可。测量数值本身是否受版权保护因司法辖区而异，网站条款属于合同约束。

**数字化方法**（`tools/datasheets/digitize.py`、`spec.json`）：

1. 用 poppler 的 `pdftocairo -svg` 把指定页转成 SVG。
2. 按 `spec.json` 中的路径编号取出矢量曲线。
3. 用“两点轴标定”（读图上的刻度线，PDF pt → 图表单位）做线性映射。
4. 不做平滑。

数字化结果已与 PDF 渲染图叠加核对过。

- Portra 400 第 4 页：
  - 特性曲线（Status M，日光，Log H Ref −1.44）
  - 光谱感光度（密度 0.2 above D-min）
  - 光谱染料密度：只有“中灰”和“D-min”两条曲线
- Ektar 100、Portra 160、Gold 200 第 4 页，Portra 800 第 4 页（特性曲线、感光度）和第 5 页（染料密度）：
  同样三张图（Status M，日光；Log H Ref 依次为 −0.84、−1.051、−1.14、−1.74）。
  - Portra 800 只用 EI 800 正常冲洗的特性曲线，同页的增感冲洗曲线不用；该图横轴标签有印刷错误（−2.0/−3.0 对调），按刻度位置标定。
  - Gold 200 的感光度曲线在 PDF 里是许多 4 pt 长的短路径，`spec.json` 用路径编号区间表示，按端点首尾相接核对过。
- Tri-X 400（F-4017 第 7 页）：35 mm、T-MAX 显影液、20 °C、6 分钟那条特性曲线（漫射视觉密度），
  以及 “D = 1.0 above gross fog” 的光谱感光度（实线）。
- Endura Premier：
  - 第 4 页：特性曲线（Status A，0.5 s）和光谱感光度
  - 第 5 页：三种归一化染料的光谱密度

**生成胶片数据**（`tools/stocks/build_stocks.py`，只依赖 numpy）：

- 重采样到 380–780 nm、5 nm 的网格（81 点），以及 Δlog H = 0.05 的网格。
- 感光度在图表范围外按每 nm 下降 0.1 log 外推，等效为 0。
- **模型假设（不是厂商数据）：** Portra 只公开了中灰和 D-min 的光谱密度，所以三种染料光谱是用 3 个双侧高斯
  拟合（中灰 − D-min）得到的，方法为 Levenberg–Marquardt。拟合结果：
  - Y = [1.061, 449.2 nm, σL 46.3, σR 38.2]
  - M = [0.817, 543.1, 33.3, 25.4]
  - C = [1.071, 708.5, 80.4, 20.0]（σR 落在下界）
  - rms 0.0067
- Ektar 100 / Portra 160 / Portra 800 / Gold 200 用同样的方法拟合，参数和 rms（0.005–0.007）写在生成文件的 `fit` 字段里。
- **模型假设（黑白）：** Tri-X 只有一条感光度和一条视觉密度曲线。三层用同一条感光度和同一条特性曲线（含片基+灰雾 0.31，作为平坦的 D-min）；
  “染料”是三段互补的平滑频带（490 / 580 nm 处的 logistic 边界），加起来是平坦的中性银密度。用 Status M 读视觉密度是近似。
  三层响应相同，引擎对这种胶片跳过层间抑制拟合；Log H Ref 数据表没给，按 ISO 400 取与 Portra 400 相同的 −1.44（假设）。
- 图表范围外，Portra 的 D-min 取常数；Endura 的染料用各自的双侧高斯拟合外延，rms 分别为 Y 0.008 / M 0.022 / C 0.034。

## 2. 标准和公开文献

| 组件 | 来源 | 用法 |
|---|---|---|
| CIE 1931 2° 配色函数 | Wyman, Sloan, Shirley, “Simple Analytic Approximations to the CIE XYZ Color Matching Functions”, JCGT 2(2), 2013 | 使用论文公开的多叶高斯解析式（`spectral.cpp`），没有使用 CIE 表格文件 |
| 普朗克辐射体 | Planck 定律（物理常数 c2 = 1.4388e-2 m·K） | 场景、印放灯和观看光源；D65/D50 用相近色温的普朗克光源近似（见第 4 节） |
| sRGB | IEC 61966-2-1:1999；原色与 D65 白点色度（x,y） | 矩阵在代码里由色度坐标推导；传递函数为分段 2.4 |
| Bradford 色适应 | Lam, K.M. (1985) 博士论文；Hunt, *The Reproduction of Colour*, 6th ed.（色适应相关章节） | 3×3 锥响应矩阵，用于把相纸白适应到 D65 |
| Status M / Status A 密度计响应 | ANSI/ISO 5-3-1995（*Photography — Density measurements — Part 3: Spectral conditions*），来自 law.resource.org 公开的“引用入法”副本 | 只取各通道峰值和按十倍衰减的点位，手工拟合双侧高斯参数（见下）；没有提交表格。**建议购买 ISO 5-3:2009 正式版本复核** |
| 光谱上采样（RGB → 反射率） | Mallett & Yuksel, “Spectral Primary Decomposition for Rendering with sRGB Reflectance”, EGSR 2019 | 思路：三条光滑、和为 1、在 [0,1] 内的基光谱，在给定光源下复现 sRGB 原色。实现是我们自己的 ADMM 二次规划（`solve_upsampling_basis`），参数由代码在运行时求解，不使用论文附带的数据 |
| 染料量解析 | 积分密度 ↔ 解析密度的一般关系（Hunt, *The Reproduction of Colour*；James (ed.), *The Theory of the Photographic Process*, 4th ed.） | 每个 log H 采样点上用牛顿法求三种染料量，使 Status 积分密度等于特性曲线 |
| DIR 耦合 / 层间效应 | Hunt, *The Reproduction of Colour*（interimage effects 一节）；DIR coupler 的一般文献描述 | 一阶抑制模型：层 k 的有效 log H 按其他层相对“中性”多出来的染料量线性抑制；数据表曲线按中性曝光测得，所以中性灰阶保持不变。6 个非对角系数在运行时由牛顿法求出，目标是消除中灰附近的层间串扰。**这是校准目标，不是 Kodak 数据** |
| 反差校准：显示参考输入 | ITU-R BT.2390（SDR 参考 OOTF，端到端 γ≈1.2）、ITU-R BT.709 / BT.1886；Hunt, *The Reproduction of Colour*（系统 γ 与环境） | `inputGamma`：灰以下按亮度做 1/γ 幂次，灰以上 1 EV 内平滑过渡回 1（膝点是我们的假设，不出自标准） |
| 反差校准：镜头杂散光 | ISO 18844:2017（veiling glare 测量）；Hunt（杂散光对阴影反差的影响） | `cameraFlare` 缺省 1%，取典型镜头的量级，是假设值 |
| 反差校准：曲线核对 | Kodak E-4070 Characteristic Curves（第 4 页）、E-4050 Characteristic Curves | 把数字化结果和 PDF 渲染图逐点比对：Endura 在 D 0.5→2.0 的斜率约 3.7，Portra Status M γ 0.55–0.63；数字化无误，见第 4 节 |
| DIR 拟合（M2） | 同上（Hunt 层间效应） | 6 个系数改为在 −2、−1、0、+1、+2 EV 灰阶上（权重 0.5/1/2/1/0.5）最小化非对角串扰的加权最小二乘（阻尼高斯-牛顿）。灰阶最差串扰 0.070 → 0.057，代价是中灰从 0 变为 0.013。权重是我们的选择 |
| DIR 抑制剂扩散 / 边缘效应（M2） | James (ed.), *The Theory of the Photographic Process*, 4th ed.（edge effects、interimage effects 章节）；Hunt | 层间抑制量和各层未抑制染料量在胶片上做高斯扩散（σ = `dirDiffusionUm`），自抑制项 = 自抑制系数 ×（扩散后 − 本地）染料量。自抑制系数取 6 个层间系数绝对值的均值，**这是假设**，没有厂商数据 |
| 高斯模糊 | Wells, “Efficient synthesis of Gaussian filters by cascaded uniform filters”, IEEE PAMI 1986；Kovesi, “Fast Almost-Gaussian Filtering”, DICTA 2010 | σ < 3 px 用精确可分离核；否则三次盒式滤波，宽度按 Kovesi 的公式 |
| 颗粒（M2） | Newson, Delon, Galerne, “A Stochastic Film Grain Model for Resolution-Independent Rendering”, *Computer Graphics Forum* 36(8), 2017；Selwyn 颗粒度定律（James 书中 granularity 章节）；Kodak Portra 400 数据表 E-4050（Print Grain Index） | 每层是半径 r 的圆盘布尔模型，强度 λ = −ln(1−u)/(πr²)；像素方差按论文的协方差积分精确计算（覆盖协方差 (1−u)²(e^{λ·A∩(d)}−1) 对高斯滤波自相关积分，扫描孔径 σ = 0.5 像素），蒙特卡洛测试核对到 ±12%。**快速近似**：空间相关用种子白噪声模糊到 σ = √(r²/4 + σ_f²) 代替逐粒子渲染。等效半径（蓝 0.14、绿 0.11、红 0.12 µm）是**假设**：数据表只给 PGI、没有 RMS 颗粒度，我们取「48 µm 孔径、中密度 RMS ≈ 0.005」这一 ISO 400 彩负的典型量级来反推；圆盘在模型里是满密度，所以等效半径远小于真实染料云 |
| 光晕 halation（M2） | James (ed.), *The Theory of the Photographic Process*（halation / irradiation 章节）；Kodak Portra 400 数据表 E-4050（乳剂层结构：红感层在最下、靠近片基） | 各层曝光 E′ = (E + s·w·blur(E)) / (1 + s·w)，在取对数之前；w = 蓝 0、绿 0.25、红 1。权重和缺省半径 0.25 mm 是**假设**（凭层序和常见扫描观感，没有测量数据）；单一高斯核而不是实测的环形点扩散函数 |
| 印放 / 扫描 | 一般的负片—相纸系统原理（Hunt） | 印放灯 3200 K × 相纸感光度；用每层印放光量把 18% 灰平衡到中性；扫描把相纸白映射为白、D-max 映射为黑（每通道黑点） |

Status 密度计双侧高斯参数（峰值 nm、左 σ、右 σ），由 ISO 5-3 的十倍衰减点手工拟合：

- Status M：B (450, 10.9, 15.8)，G (540, 16.6, 16.5)，R (640, 5.5, 20.0)
- Status A：B (440, 7.9, 12.6)，G (530, 7.6, 15.1)，R (620, 6.0, 25.0)

## 2a. 预设与附加项（FrameFlow 调校假设，不是厂商数据）

`server/src/domain/grading/film-presets.ts` 的 `signature` / `soft` 预设只改引擎公开的渲染参数
（曝光 EV、DIR 层间抑制强度、印放中灰、相机杂散光、场景色温），**数值是 FrameFlow 凭观感定的假设**，
没有任何数据表或第三方实现作依据；色彩本身仍全部来自上表的数据表。`neutral` = 引擎缺省。
其中 Portrait 800 / Golden 200 的 `sceneKelvin`（5000 K / 4800 K）用于偏暖，方向未用标准色卡验证。
边框（等宽加边 + 补画幅）与暗角（smoothstep 径向压暗）是 FrameFlow 自己的简单图像操作，不模拟任何物理过程或产品。

## 3. 代码

`engine/` 下的全部 C++ 和 Python 代码都是 FrameFlow 项目从头编写的。第三方依赖只有 C++20 标准库；
工具脚本使用 numpy 和 poppler（`pdftocairo`，命令行调用，不链接）。

## 4. 已知偏差（验证记录）

- Portra 中灰负片的 Status M 密度为 B 1.763 / G 1.363 / R 0.888；数据表灰卡的 R 约为 0.77–0.87，**略偏高**。
- 数据表 D-min 为 0.80 / 0.63 / 0.20；模型由 D-min 光谱计算得到 0.803 / 0.632 / 0.197，吻合。
- 灰阶中性度：显示值（sRGB 编码）偏差 < 0.02（约 5/255）。高光略偏蓝，+1 EV 时约 +3%。
- 观看和扫描光源用普朗克 6504 K 近似 D65，没有使用 CIE D 系列的 SPD 表。
- 反差（M2 校准）：数据表曲线本身没错——Endura 中段斜率约 3.5–3.7、Portra 印放密度 γ≈0.58，场景→相纸的中灰系统 γ（d log 输出 / d log 输入）≈1.95，−1 EV 处 2.6，这和真实相纸一致。偏高的原因是 M1 把相机 JPEG（已套过色调曲线）当成场景线性。M2 缺省 `inputGamma`=1.2 + `cameraFlare`=0.01 后，中灰系统 γ 为 1.54，−1 EV 为 1.94，−3 EV 为 1.33，白点仍 > 0.85。RAW 场景线性输入请设 `inputGamma`=1。
