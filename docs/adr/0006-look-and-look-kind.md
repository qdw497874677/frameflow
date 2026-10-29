# ADR 0006：风格（Look）与风格类型（LookKind），每类自带参数模式

状态：**已接受**（2026-10，用户 pt54u「现在我们的模型中，把他们都叫做滤镜吗，找一个词收敛一下，然后每个都支持一些自己特有的配置项 比如边框，扭曲，噪点等等，每个路径自己定义的」）
相关：[核心模型](../core-model.md) · [GLOSSARY](../../GLOSSARY.md) · [ADR 0005](0005-typescript-backend.md) · `engine/PROVENANCE.md`

## 背景

grade 阶段起初只有内置 .cube（「滤镜」），后来接入光谱胶片引擎（「film 风格」），又长出颗粒 / 光晕 / DIR 等只对胶片有效的
整帧效果（`params.film`）。代码、API 与界面里同一个东西叫「滤镜」「风格」「look」「LUT」「cube」，参数是按胶片写死的
（`FilmEffectsPanel` 的 KNOBS 列表、`params.film`）。用户要的是：一个统一的词；每条路径（LUT、胶片……）自己定义特有的配置项，
例如边框、扭曲、噪点。

## 决定

1. **术语**：用户能选的一个东西叫 **风格（Look）**；承载它的实现路径叫 **风格类型（LookKind）**，现有 `lut`（内置 .cube）与
   `film`（光谱胶片引擎）。「滤镜」不再用于模型与界面（中文界面统一叫「风格」）。选 Look 而不是 Filter / Preset：
   Filter 暗示单个像素操作、Preset 暗示参数快照；Look 是调色行业对「一整套观感」的通称，也能装下边框这种非像素映射的附加项。
2. **注册表**：`LookKindRegistry` 把每个风格来源挂到一个类型上，按风格 id 找类型（`kindOf`）。加一条路径 = 实现一个 `LookKind`
   （`schema / validate / normalize / effects`）并注册，grade 任务、HTTP 与前端都不用改。
3. **参数模式**：每类型声明分组与参数，参数类型有 `number`（min/max/step/unit）、`enum`、`bool`、`color`、`seed`；
   每个参数带 `preview`：`lut`（改变烘出的 .cube，预览即真）、`approx`（前端近似，导出时服务端真做）、`export`（只在导出 / 裁切预览里真渲染）。
   分组 `extra: true` 标出类型自带的附加项。校验严格（未知键、越界 400），归一宽松（换类型时带不过去的参数丢掉）。
4. **共享附加项**：边框（边宽占短边比例、颜色、补到画幅）与暗角由 `look-kind.ts` 提供描述符、`frame-extras.ts` 提供效果，
   类型自己决定挂不挂。边框会改变成品尺寸，所以 `Effect.apply` 可以返回新图像。
5. **配方**：任务存 `params.recipe = { lookId, kind, params }`。旧的 `look / strength / film` 仍被接受（建任务、`defaults`），
   开跑时折算进 recipe 并移除旧字段；逐张覆盖仍是 `{ look, strength }`。
6. **API**：新增 `GET /look-kinds`（模式）；`/looks` 的 `kind` 值 `cube` 改名 `lut`；`/looks/{file}.cube` 接受该类型参数作查询串；
   `/film/preview` 接受 `params`（旧 `strength / film` 兼容）。
7. **film 类型的参数**：强度、相纸（`premierpaper` / `edgepaper`，来自各自数据表）、预设（`signature` / `neutral` / `soft`，FrameFlow 调校假设，
   见 PROVENANCE 2a）、曝光补偿、颗粒（含种子、画幅）、光晕、DIR 边缘，加暗角与边框。
8. **前端**：配置面板由模式自动生成（按分组 / 类型选控件），不再手写每个旋钮。

## 后果

- 加「扭曲」「漏光」等新附加项只要在某个类型的模式里声明并实现效果；面板自动出现。
- `kind: cube` 改名是一次小的破坏性改动（只影响读 `/looks` 的客户端）；已在 openapi 注明。
- `approx` 参数的预览与导出不逐像素一致（边框 / 暗角足够接近；颗粒等仍需裁切预览看真效果）。
