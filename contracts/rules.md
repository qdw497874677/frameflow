# 归档规则 DSL · v1 规范

> ⚠️ **已停放：这套能力不在产品路线上（2026 起）。**
> 归档（含规则引擎、`/archive/*` 与 `/rules` 端点、前端两个页面）已整体移除：用户判定「文件夹我可以先整理好，只需要导入文件夹扫描所有照片进行标记就可以了」（m01572）。见地图的 Out of scope 与 [ADR 0003](../docs/adr/0003-project-is-a-mapped-directory.md)。
> 本文保留为**规范草稿**，只在将来重做「导出 / 归位」时参考。当前实现里**没有** `Rule` 类型、没有规则页、契约里没有 `/rules`。

状态：由历史决策 003 钉死，原记录可查 Git 历史；随后被移出路线，见上。前端 `GET/PUT /rules` 曾读写这份结构，
`web/src/core/types.ts` 的 `Rule` / `RuleMatch` 曾是它的 TypeScript 投影。

## 1. 文件与加载

- 位置：应用配置目录下的 `rules.yaml`（当时将具体路径留给历史决策 004，原记录可查 Git 历史）。单用户一份，全局生效；v1 不支持 per-root 规则。
- 顶层 `version: 1` 是迁移锚点；缺省视为 1，未知版本拒绝加载。
- `rules` 是**有序数组**，顺序即优先级。
- 加载时校验：未知变量、未知字段、非法值一律**拒绝整份文件**并把错误报到 UI，不静默忽略。
- `id` 稳定（UI 改名不改 id）；删除后重建会得到新 id。

## 2. 一条规则长什么样

```yaml
version: 1
rules:
  - id: rule-starred
    name: 喜欢的（≥3 星）→ 修改后
    enabled: true
    onlyFrom: ["{root}/*/待整理"]      # 可选：候选来源目录 glob，缺省 = 不限
    match:
      kind: photo                      # any | photo | video，也可写数组
      stars: { gte: 3 }
      camera: [A7M4, "X-T5"]           # 数组 = 或
      lens: ["35 1.4"]
      taken: { after: 2026-01-01, before: 2026-12-31 }
      folder: "{root}/2026-*"
    action: move
    dest: "{root}/{project}/{device}/照片/修改后"
    onConflict: rename                 # rename | skip
    pair: true
```

## 3. 语义

### 3.1 判定

- 规则自顶向下，**首条命中即停**（first-match-wins）。
- 同一条规则内，不同条件之间是 **AND**；同一条件写数组是 **OR**。
- 候选集合只是「待归档目录下的照片/视频」。**待删（`del: true`）的照片永远不参与归档**，
  直接进 `skipped`，原因 `待删：先移入回收站`。
- 目标目录 = 源目录 → `skipped`，原因 `已经在目标目录`。
- `onlyFrom` 不匹配 → 该规则对这张照片不参与判定。

### 3.2 动作

| action | 含义 |
| --- | --- |
| `move` | 移动到 `dest` |
| `skip` | 明确不动（用来「保护」一类照片不被后面的规则搬走） |

v1 **没有 copy**：复制会立刻产生两份真相。

### 3.3 条件

| 字段 | 取值 | 语义 |
| --- | --- | --- |
| `kind` | `any` / `photo` / `video`，或数组 | 照片 / 视频 |
| `stars` | 数字 = `gte`；或 `{ gte, lte, eq }` | 星级区间。`stars: 0` 是**非法写法**（0 不是下限），未打星用 `marked: false` 或 `{ eq: 0 }` |
| `marked` | `true` / `false` | 是否打过星（`stars > 0`） |
| `camera` | 字符串或数组 | 机型。值可用别名（见 §4），匹配方式为**包含、大小写不敏感**；要精确写 `=ILCE-7M4` |
| `lens` | 同 `camera` | 镜头 |
| `taken` | `{ after, before }` 或 `{ lastDays }` | 拍摄日期区间（含端点），`YYYY-MM-DD` |
| `folder` | glob | 照片**当前所在目录**的绝对路径，`*` 不跨 `/`，`**` 跨 |

v1.1 候选：文件名模式 `name`；EXIF 光圈 / ISO / 焦段。

### 3.4 目标模板

| 变量 | 展开成 |
| --- | --- |
| `{root}` | 该照片所属根目录的绝对路径 |
| `{project}` | 项目名，整批只解析一次（见 §3.5） |
| `{device}` | 机身**别名**；无法识别时 `未知机身` |
| `{kind}` | `照片` / `视频` |
| `{variant}` | `原始` / `修改后`；视频恒为 `原始` |
| `{date:FORMAT}` | 拍摄日期，`FORMAT` ∈ `YYYY MM DD HH mm ss`，缺省 `YYYY-MM-DD` |
| `{folder:N}` | 当前目录相对根的第 N 层目录名 |
| `{camera}` | 原始 EXIF 机型串（不套别名） |
| `{lens}` | 原始 EXIF 镜头串 |
| `{name}` | 主文件名，不含扩展名 |
| `{ext}` | 扩展名，小写，不含点 |

- 未知变量 = 校验失败。
- 模板必须展开成**绝对路径**；允许落在该 root 之外（跨盘归档），但禁止 `..` 逃逸。

### 3.5 `{project}` 的解析

1. 本次归档手动指定了项目名 → 用它，并**记住在该目录上**（下次预填）。
2. 否则取批内拍摄日的跨度：单日 `2026-03-05`；跨日 `2026-03-05_2026-03-08`。
3. 一个 plan 只解析一次（`{project}` 不逐张变化）。

目录名推断**不是** `{project}` 的默认值，它是普通变量 `{folder:1}`。

### 3.6 日期从哪来

EXIF `DateTimeOriginal`（视频取 QuickTime `CreateDate`）→ 文件名里的日期（`YYYYMMDD` / `YYYY-MM-DD`）→ 文件 `mtime`。
预演里每张标注来源（`exif` / `filename` / `mtime`）。
相机写的是当地时间，**不做时区换算**，「墙上时间」直接使用。

### 3.7 冲突与成组

- 目标已有同名：`rename`（默认，追加 `-1`、`-2`…）或 `skip`（计入 `skipped`）。**永不覆盖。**
- 同一组的成员共用同一个冲突后缀。
- `pair: true`（默认）时，移动的最小单位是**组**：主文件（RAW 与/或 JPEG，同一 stem）+ 影子文件。
  影子文件认三种写法：`{stem}.xmp`、`{stem}.{ext}.xmp`、`{stem}.{ext}`（`.aae` / `.dop` / `.pp3`）。名单可扩展。
- 成组移动是**组内原子**的：任一成员失败则整组记入 `failed`，不留半组。

### 3.8 预演与执行

- `POST /archive/plan` 只读：产出每条 move（`photoId` / `from` / `to` / `ruleId`）+ `skipped`（含原因）+ `totalBytes`；plan 有效期 30 分钟（`expiresAt`）。
- `POST /archive/apply { planId }`：执行前重新校验磁盘（源还在不在、目标是否被占），差异按本文档处理，逐条记进结果。跨文件天然做不到整体原子，但**每组原子**。
- apply 落一份移动日志（plan + 结果）供事后对账；「撤销这次归档」按钮留 v1.1。

## 4. 别名表

`devices.yaml`（应用配置目录，与 `rules.yaml` 分开，因为它描述的是「我的器材」而不是「我的口味」）：

```yaml
cameras:
  ILCE-7M4: A7M4
  "X-T5": X-T5
lenses:
  "FE 24-70mm F2.8 GM II": 24-70GM2
```

- 后端统一应用：`Photo.camera` / `Photo.lens` 输出的已是别名（命中时），`{device}` 用别名。
- 规则匹配同时接受别名与原始串。
- 为什么需要它：EXIF 里是 `ILCE-7M4` 这类厂内代号，而人写规则时想的是 A7M4。

## 5. 前端投影

- 前端只认 `GET/PUT /rules` 的 `Rule[]`，字段与本文档一致。
- 规则编辑 UI 曾由历史决策 007 设计，本文档当时是它的输入；原记录可查 Git 历史。
