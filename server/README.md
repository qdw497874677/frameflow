# server（后端）

**状态：已实现并在用（TypeScript / Node 22 LTS+，见 [ADR 0005](../docs/adr/0005-typescript-backend.md)）。**
已落地：扫描 + RAW/JPEG 配对、两档缩略图（含视频抽帧封面）、XMP 星标/待删 + `marks.jsonl`、回收站、索引缓存、认证三凭据（session/Bearer/链接 token）、`/capabilities`、`/api-tokens`。
未落地：`/jobs*`、`/channels*`（契约里 `x-implemented: false`）；运行与部署形态（systemd / Docker / 反代）仍见 `wayfinder/tickets/005-stack-deployment.md`（待定）。
本文件先固定**模块边界**与职责，避免前端/后端职责漂移。

## 职责边界

后端是唯一接触磁盘的进程。前端（`web/`）不做任何文件系统访问，只通过 `contracts/openapi.yaml` 的 HTTP API 交互。

## 内部模块（各自独立、可单独测试）

| 模块 | 职责 | 关键约束（来自已关闭的票） |
|---|---|---|
| `scan` | 目录遍历、照片发现、RAW+JPEG **配对** | 同目录 + stem 大小写不敏感相等 + 扩展名分类；多 RAW 取字母序最早；每次扫描重建配对（票 001） |
| `preview` | 分层预览管线：外部 JPEG → 内嵌 JPEG 提取 → LibRaw 兜底 | 512 / 2048 两档缓存，缓存键 `path+mtime+size`；内嵌 JPEG 缺 Orientation 需回填（票 001） |
| `marks` | 星级 / 待删的持久化，以及变更日志 | 星级写共享 XMP（`xmpDM:good`，与 LR/C1 互通）；pair 为一等实体，成对写入（票 001）；每个实际变化的字段追加一条 `marks.jsonl`（含 `by/at/channel/from→to`）—— 外部批注回流的对账凭据 |
| `jobs` | 任务层：一个能力一个 handler | 契约 `validate → plan → apply → undo?`，只依赖 `core/`，handler 之间不互相 import；先预演再执行；每个任务落 manifest（做了什么）与事件日志（`jobs.jsonl`）；执行队列不持久化，重启把 `running` 标 `interrupted` |
| `channels` | 批注通道（应用内 / 飞书 / 其他客户端） | 入方向走 `/channels/{id}/inbound`；v1 不建账号体系，用范围受限的链接 token，回流记 `by: 'link:<别名>'` |
| `storage` | 状态与日志的落盘位置 | 索引/缓存可重建；事件日志与 manifest 不可重建，必须追加写（见 `docs/core-model.md` 不变量 6） |
| `trash` | 逻辑删除区（产品回收站）—— 已实现 | 删除 = 移入产品回收站，可恢复；pair（含 `.xmp` 侧车）成对进出（票 001 + 用户决策）；搬走时**顺手把标记清掉**（`channel:'trash'`），否则还原后会带着「待删」回来，而挑片默认隐藏待删 —— 照片就像消失了；落地在 `<照片目录>/.trash/<显示名>/`，记录与日志在 `dataDir/trash.jsonl`（`{op:'in'|'out'}` 追加写，重启后按它重建回收站索引）；`dir/.trash` 下的文件**不参与扫描配对**；还原时同名文件排号（`名字 (2)`），绝不覆盖 |
| `roots` | 根目录列表与在线检测 | 多根（本地盘/挂载点）；`online=false` 表示当前不可访问，前端只灰显不报错（票 004） |
| `auth` | 单用户认证与会话 | 家用 + Tailscale 场景下的最简方案（票 005） |
| `httpapi` | HTTP 层：路由、序列化、错误码 | 严格实现 `contracts/openapi.yaml`；不含业务逻辑，只做编解码与调用 |
| `annotate` | AI 参与选片（`jobs/annotate.ts`） | 两种形态：作为执行者（我们调模型，`executor: openai-compatible / anthropic / ark / ollama`）与作为客户端（外部 agent 自己来取活干）；产出标注记 `by: 'ai:<model>'`；输入图像取 `GET /photos/{id}/thumb?size=2048`（见 `docs/core-model.md` §11） |
| `mcp` | 把同一批端点包成 MCP 工具（`list_photos` / `get_photo` / `set_marks` / `create_job` / `job_status`） | 薄适配器，不含业务语义；与 `httpapi` 共用 `core/` 的调用面；给 Claude Code 等 agent 直接用 |
| `capabilities` | 能力自描述（`GET /capabilities`） | 注册表投影：job kinds + 参数 schema + 副作用等级 + 通道 + 执行者；前端与 AI 客户端都靠它发现能力（ADR 0005） |
| `plugins` | 第三方模块的加载与校验 | 与内置同一 manifest 契约，从数据目录加载；**模块不能直接碰磁盘**，只能经 `core/`；副作用等级不符则拒绝（见 `docs/core-model.md` §12 / 票 010） |

## 前端已经依赖的接口

前端已完成（`web/`），它按 `contracts/openapi.yaml` 调用以下端点；后端照此实现即可跑起来：

`GET /health`、`POST|DELETE /session`、`GET /roots`、`GET /folders`、`GET /photos`（选择集用 `?sel=`，语法见 `contracts/selection.md`）、`GET /photos/{id}/thumb|file`、`PUT /marks`、`GET /marks/history`、`GET|POST|DELETE /trash`、`POST /trash/restore`。

`/jobs`、`/jobs/{id}/events|cancel|undo`、`/channels`、`/channels/{id}/inbound` 已在契约里**预留形状**（`x-implemented: false`），但前端暂不调用 —— 它们属于第一个异步能力（导出）落地时的事。

## 任务层的接缝（实现第一个异步能力时照这个来）

```ts
// 每个能力一个文件：server/src/jobs/export.ts、trash.ts、process.ts、annotate.ts…
interface JobHandler<P> {
  kind: string;                                   // 'export' | 'trash' | 'process' | 'annotate'
  validate(params: P, ctx: Core): void;           // 参数不对就在创建任务前就报错
  plan(selection: Selection, params: P, ctx: Core): Promise<Plan>;   // 只读预演，产出 manifest 预览 + 体积/目录数
  apply(plan: Plan, ctx: Core, report: Progress): Promise<Manifest>; // 真干，逐单位记 manifest
  undo?(manifest: Manifest, ctx: Core): Promise<void>;               // 可选，声明了才是可撤销任务
}
```

handler 只依赖 `core/`（扫描、配对、XMP、路径、选择集求值），不 import 其它 handler；
新增能力 = 新增一个 kind，`httpapi` 与前端零改动。第一个落地的是 **导出**（只写新位置，不碰原片）。

三条后端必须自己保证的语义（前端已按此编写，且 mock 实现里可见）：

1. `PUT /marks`：`stars > 0` 与 `del = true` 互斥，同时给出时以 `del` 为准；按 pair 写入共享 XMP；每个实际变化的字段追加一条变更日志（`GET /marks/history` 读它）。
2. `POST /trash` 只是移入产品回收站（可还原）；`DELETE /trash?confirm=true` 是**唯一**删磁盘文件的入口，`ids` 为空 = 清空回收站。
3. 应用不导入、不导出、不搬动照片：除了写星标与回收站操作，**不碰原文件**。
4. `GET /photos?sel=` 的谓词求值语义见 `contracts/selection.md`（前端 `matchesSelection` 是参考实现）。

## 模块注册与能力自描述（第一个模块落地时就这样写）

```ts
// server/src/jobs/<kind>.ts —— 每个能力一个文件
export const manifest = {
  kind: 'export',
  label: '导出',
  params: exportParamsSchema,            // zod / JSON Schema，供 /capabilities 与校验共用
  sideEffect: 'newLocation' as const,    // readonly | mark | library | newLocation | originals
  undoable: true,
  needsNetwork: false,
};
export const handler: JobHandler<ExportParams> = { validate, plan, apply, undo };
```

`jobs/registry.ts` / `channels/registry.ts` 汇总所有模块；`GET /capabilities` 就是这张表去掉实现细节后的投影。
**新增能力 = 新增一个文件 + 注册一行**；前端与 AI 客户端读 `/capabilities` 自适应，不需要改代码。

## 索引缓存与冷启动（2026-10-06）

启动顺序不变（**先监听、再后台扫描**），但列表不必等扫描：`dataDir/index.json` 里除了 `metaCache`（EXIF：mtime+size 没变就跳过 exiftool），还存了上次扫描的 `records`/目录树/root 在线态（`version: 2`）。

- `Library.loadIndex()` 恢复完就是可服务状态，`refresh()` 随后在后台校正；`/capabilities.library.scanning` 为 `true` 时前端展示的是「先用缓存，补扫中」。
- **启动不碰文件系统**：`roots()` 优先用缓存里的 `online`，避免对可能挂死的挂载点做 `existsSync`（票 011 的方向）。
- 星标/待删不依赖扫描：`MarksStore` 启动即读 `marks.jsonl`，DTO 里的 `stars`/`del` 以它为准（XMP 只是种子）。
- 失效即重建：版本号不符、JSON 坏了、`records` 为空 → 当没有缓存，照旧全量扫描覆盖。
- 回归：`node tools/e2e-cold-start.mjs`（重启后断言「扫描还没跑完就能出照片」+ 日志里的「索引缓存已就绪」）。

## 不变式

1. **磁盘是真相**：不建媒体库、不复制导入；数据库（若有）只是索引/缓存，永远可重建。
2. **成对原子**：RAW+JPEG 配对在打标、删除上永远一起行动。
3. **只有两处写磁盘**：星标/待删（XMP）与回收站（移入 `.trash` / 还原 / 真删）；变更日志与任务 manifest 是**追加写**的新文件，不改动已有内容。
4. **可重建**：预览缓存与索引删除后，重扫即可恢复。
