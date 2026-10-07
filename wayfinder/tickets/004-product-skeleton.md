---
id: "004"
title: 产品骨架决策（已收窄：只剩「标注任务」骨架）
labels: [wayfinder:grilling]
status: closed
assignee: ""
blocked-by: []
---

## 状态（2026-10-06 收窄）

原六个连锁决策里，**前五条已经在实现里落地、并被真库探针验证**（见下）；本票只剩第 6 条：面向「标注任务」的骨架。
收窄的原因：前五条再挂着「未定」会白挡票 008，而它们已经是代码事实、不是待决问题。

## 已定（1–5，附落地证据）

1. **映射机制**：根目录写在 `server/artworks.config*.yaml` 的 `roots:`（`server/src/config.ts` 的 `normalizeRoots()`：`id/label/path`，label 缺省取目录名）；可以映射多个（本机 + NAS）；不导入不导出（[ADR 0003](../../docs/adr/0003-project-is-a-mapped-directory.md)）。目录被拔走 → `GET /roots` 的 `online:false` + `lastError`（票 011），前端只灰显不报错。
2. **回收站**：`<照片目录>/.trash/<显示名>/`（与被删文件同共享，`rename` 才原子），RAW+JPEG+侧车成对进出，还原排号不覆盖，真删要 `?confirm=true`；`dataDir/trash.jsonl` 追加写、重启重放（`server/src/core/trash.ts`）。
3. **评分/待删存哪**：写照片旁的 XMP（`xmp:Rating`，-1 = 待删，与 LR/C1 互通）；XMP 写不进时以 `dataDir/marks.jsonl` 为准。归档规则已砍（[ADR 0002](../../docs/adr/0002-archive-rule-semantics.md) 标为取代），所以「规则移动后状态跟着走」这个问题不存在了。
4. **访问控制**：可选密码 + 三种凭据 —— session cookie / Bearer API token / 只读缩略图链接 token；撤销 API token 会连带失效它签发的链接 token（`server/src/api/auth.ts`；票 009 的 2026-10-06 进展）。Tailscale 内网 + 需要时开密码门。
5. **项目名/显示名**：显示名 = 目录名/文件名去掉扩展名（`server/src/core/scan.ts` 的 `displayName`），不做别名表；器材名直接显示 EXIF 原串（`ILCE-7M4`），不做「人话化」映射。

## Question（收窄后：只剩第 6 条）

面向「标注任务」的骨架：把一次挑选当成可派发的**任务**（有状态、有范围、有产出），将来能推到 IM（飞书）或其他客户端去批注、结果再回流。三件事：

1. **任务是不是一等实体**：契约里 `/jobs` 现在只是给「导出」预留的形状（`x-implemented: false`）。标注任务要不要复用同一个实体（`kind: 'annotate'`，`selection` 当范围、`manifest` 当派发记录、`events` 当回流流水），还是标注只是「选择集 + 通道」、不进任务表？
2. **外部批注者的身份**：v1 不建账号体系。范围受限的链接 token（只能读这一批 + 只能写标注 + 可撤销）够不够？回流记 `by: 'link:<别名>'`（别名在签 token 时给）行不行？这决定票 008 的权限模型。
3. **回流与合并**：外部标完是**直接落**（写 XMP + `marks.jsonl`，历史里带 `by`，要撤可撤），还是先落「建议层」等本人确认？本人同时在标时的冲突怎么处理（后写覆盖 + 留历史，还是要乐观并发 `expectedFrom`）？

产物：这三条定了，票 008 就能把 `/jobs`、`/channels`、`/marks/history` 写进 `contracts/openapi.yaml`。

## Resolution（2026-10-06）

三条都按「复用已有骨架」定（用户 m01166「都按照推荐」）：

1. **标注任务是一等实体**：复用 `/jobs`，`kind: 'annotate'` —— `selection` 是范围、`manifest` 是派发记录（发给谁 / 哪一批 / 什么渠道）、`events` 是回流流水。通道（飞书 / 其他客户端）只是投递方式，不是任务本身；导出等将来的异步能力是同一实体的其它 kind。
2. **外部批注者用范围 token**：把现有链接 token 从「只读缩略图」扩成带 scope 的载荷（`annotate:<jobId>`）—— 只能读该任务的选择集 + 缩略图、只能写标注、可撤销（撤销签发它的 API token 即连带失效）、有有效期；回流记 `by: 'link:<别名>'`（别名在签 token 时给）。
3. **回流直接落 + 全历史，不做建议层**：外部标注直接写 XMP + `marks.jsonl`（`by/at/channel/from→to`），复核与回退走现成的 `GET /marks/history` + 撤销；冲突后写覆盖 + 历史留痕，乐观并发（`expectedFrom`）等真出现「两个人同时标同一张」再加。

产物：票 008 的权限模型与 `/jobs` 形状据此展开；本票同时把前五条（映射机制 / 回收站 / XMP 存储 / 访问控制 / 显示名）标为已落地，不再当待决问题挂着。
