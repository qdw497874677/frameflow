# 选择集（Selection）

**选择集是「哪些照片」的谓词，不是 id 清单。**

任务是「选择集 + 操作 + 参数」（见 `docs/core-model.md`）：导出、删除、处理、把这一批推给人批注，
都先要知道「这一批是哪一批」。谓词能进 URL、能存进任务、能在外部渠道里被复现
（对方问「我看到的也是这 37 张吗」，答案是「同一段谓词、同一份盘」，而不是一串会过期的 id）。

创建任务时谓词会被**展开成 `items` 快照**（任务详情里那一批就是这些 —— 派发出去必须稳定）；
谓词本身仍留在 `selection` 里当「怎么选出来的」凭据。这也是谓词语言故意保持窄（不引入 OR）的原因：
谓词要能在任务预览里被人确认。

## 两种表示，语义完全一样

| 表示 | 用在哪 | 形状 |
|---|---|---|
| 对象形式（canonical） | 任务的 `selection` 字段、后端存储、`POST /jobs` | `{ project?, where?, ids? }` |
| 紧凑字符串形式 | URL `?sel=`、`GET /photos?sel=` | `stars>=3,marked,kind:photo` |

前端实现：`web/src/core/selection.ts`（`selectionToQuery` / `selectionFromQuery` / `matchesSelection`）。
线格式 schema：`contracts/openapi.yaml` 的 `Selection`。

## 对象形式

```jsonc
{
  "project": "/photos/2026-冰岛",   // 项目（被映射的目录）；省略 = 当前目录
  "where": {
    "kind":   "photo",              // photo | video
    "by":     "ai",                 // 标注来源前缀：me | ai | link（由 marks.jsonl 推导，前缀匹配）
    "stars":  { "gte": 3 },         // gte / lte / eq，可组合（区间）
    "del":    false,                // 是否标了待删
    "marked": true,                 // 是否打过星（stars > 0）
    "folder": "A7M4",               // 目录包含匹配，大小写不敏感
    "camera": "A7M4",               // 机身包含匹配，大小写不敏感
    "taken":  { "after": "2026-03-05", "before": "2026-03-08" }   // 拍摄日，闭区间
  },
  "ids": ["mock-3", "mock-7"]       // 手选清单；与 where 同时存在时取交集
}
```

- `where` 内**字段之间是 AND**；`stars` 对象内的 `gte`/`lte` 也是 AND（所以能表达区间）。
  需要「≥3 或 待删」这类 OR，写成两个选择集 / 两个任务 —— 谓词语言故意不引入布尔表达式，
  因为「保存下来的筛选条件」一旦带 OR，用户在任务预览里就很难确认自己选了什么。
- 空 `{}` = 该目录的全部照片。
- `project` 不参与逐张求值（它决定去哪个目录列），求值的只有 `where` + `ids`。

## 紧凑字符串形式（`?sel=`）

词之间用 `,` 分隔；认不出的词**忽略**（向前兼容：后端将来加词，旧客户端不炸）。

| 词 | 等价对象字段 |
|---|---|
| `stars>=3` / `stars<=2` / `stars=0` | `where.stars.gte` / `.lte` / `.eq` |
| `del` / `del:false` | `where.del = true` / `false` |
| `marked` / `marked:false` | `where.marked = true` / `false` |
| `kind:photo` / `kind:video` | `where.kind` |
| `folder:2026-冰岛` | `where.folder` |
| `camera:ILCE-7M4` | `where.camera` |
| `taken>=2026-03-05` / `taken<=2026-03-08` | `where.taken.after` / `.before` |
| `project:<path>` | `project` |
| `ids:a\|b\|c` | `ids`（用 `\|` 分隔，避免和词分隔符 `,` 冲突） |
| `by:ai` / `by:me` / `by:link` | `where.by`（**前缀匹配**：`by:ai` 命中 `ai:gpt-4o`） |

值里可能出现 `,` `|` `:`（目录名里什么都有），所以**词的取值部分按 URL 编码写**
（`folder:%E5%86%B0%E5%B2%9B`），整个 `sel` 再作为查询参数编码一次（`URLSearchParams` 负责）。
解析时按 `,` 切词，再对取值 `decodeURIComponent`。

`GET /photos?filter=` 是**弃用**的旧枚举（`all|starred|trash|unmarked`），
等价于 `starred ⇔ marked`、`unmarked ⇔ marked:false`；新代码只用 `sel`。

## 求值语义（后端照此实现）

逐张照片求值，`where` 字段全部满足才算命中：

1. `ids` 非空 → id 必须在其中（再继续判 `where`）。
2. `kind` → `photo.kind === kind`。
3. `del` → `photo.del === del`（**默认不过滤待删**：回收站是独立页面，挑片页里「待删」是状态不是筛选）。
4. `marked` → `(photo.stars > 0) === marked`。
5. `stars.eq` / `.gte` / `.lte` → 数值比较。
6. `folder` → `photo.dir` 包含该串（大小写不敏感）。
7. `camera` → `photo.camera` 包含该串（大小写不敏感；服务端输出的是别名，见 `devices.yaml` 的停放说明）。
8. `taken.after` / `.before` → 拍摄日的**闭区间**；拍摄日 = `capturedAt` 的日期部分，
   缺 `capturedAt` 时回落 `mtime`（两者都是「墙上时间」，不做时区换算）。
9. `by` → 该照片**最后一次标注变更的来源**，由 `marks.jsonl` 推导（XMP 只存最终状态，没有来源字段）。
   前缀匹配（`by:ai` 命中 `ai:claude`）；**从未标注过的照片不匹配任何 `by` 词**。

排序与分页不受选择集影响：仍是目录内稳定的自然顺序 + `cursor`。

## 不做

- 布尔表达式（AND/OR/NOT 组合）—— 见上文，代价是确认成本，不是实现难度。
- 保存的命名筛选（saved search）：等有第二个人用再说（票 004/008）。
- 按标注**时间**筛选：等 `marks.jsonl` 真被人用起来再评估（`by` 已经做了，时间还没）。
