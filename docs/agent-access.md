# Agent 接入指南（pull 形态）

> 给 AI agent（Claude / GPT / 本地脚本 / 另一个 pi 会话）的操作说明。
> 决策背景：历史决策 009（原记录可查 Git 历史） —— AI 介入选片走 **pull**：agent 当普通 API 客户端来取活干，
> 服务进程不存模型 key、不花钱、换模型只换客户端。push 形态（我们调模型，`/capabilities.executors`）
> 全部是 `status: 'planned'` 的占位，**尚未实现，别用**。

API 线格式以 [`contracts/openapi.yaml`](../contracts/openapi.yaml) 为准；本文是「怎么用好它」的 cookbook。

## 1. 凭据：签一次，两种用法

服务端认三种凭据，agent 只需要前两种：

| 凭据 | 形态 | 能干什么 | 生命周期 |
|---|---|---|---|
| **API token** | `Authorization: Bearer <token>` | 全部 API（读 + 写标注 + 建任务 + 回收站） | 长期，可撤销 |
| **linkToken** | URL 查询参数 `?t=<linkToken>` | **只读缩略图**（512/2048），别的一律不算凭据 | 30 天，跟随签发它的 API token |
| 会话 cookie | 浏览器专用 | —— | 30 天 |

签发（UI 设置页里有同款按钮；本机免认证时也能直接调）：

```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/api-tokens \
  -H 'content-type: application/json' \
  -d '{"label": "claude-sonnet-4.5"}'
# → { "token": "aw_…（明文只出现这一次）",
#     "linkToken": "eyJ…", "linkExpiresAt": "…",
#     "thumbUrlTemplate": "/api/v1/photos/{id}/thumb?size={size}&t=eyJ…" }
```

要点：

- **label 写模型名**。Bearer 写入的标注自动记 `by: 'ai:<label>'`、`channel: 'api'`（见 §3），label 就是区分「谁标的」的全部依据。
- `linkToken` 解决一个硬约束：agent 把图片 URL 交给**自己的**图像加载器/模型服务商去取，那里**带不上自定义 header** —— 所以缩略图 URL 必须自认证。`?t=` 只在 `/thumb` 路由被消费。
- 撤销：`DELETE /api/v1/api-tokens?id=<id>`；Bearer 与 linkToken 一起失效。
- 红线：`POST /api/v1/trash?confirm=true` 是**真删磁盘文件**的唯一入口，agent 不要碰（不变量见 [core-model](core-model.md) 1）。

## 2. 挑片循环（核心 cookbook）

```
① 认路     GET /api/v1/health → roots
② 列片     GET /photos?dir=…&sel=…&limit=50（cursor 翻页）
③ 看图     GET /photos/{id}/thumb?size=2048&t=<linkToken>   ← URL 自认证
④ 写标     PUT /marks  { items: [{ id, stars: 0..5 | del: true }] }
⑤ 复核     GET /photos?dir=…&sel=by:ai  （sel 还支持 stars>=3、marked:false、kind:photo…）
```

```bash
BASE=http://127.0.0.1:8787/api/v1
TOK=aw_…; LINK=eyJ…

# ① 项目（root）列表 → 侧边栏虚拟路径，根 = /<rootId>
curl -s $BASE/roots -H "authorization: Bearer $TOK"

# ② 某目录还没标的照片（sel 语法见 contracts/selection.md；marked:false = 从未标注）
curl -s "$BASE/photos?dir=/test/20260328-西溪园区樱花/黑卡7/原照片&sel=marked:false&limit=50" -H "authorization: Bearer $TOK"

# ③ 2048 预览（视频也是它：服务端 ffmpeg 抽帧当封面）
curl -s "$BASE/photos/<id>/thumb?size=2048&t=$LINK" -o p.jpg

# ④ 写星（0..5；与 del 互斥；一次可批量）
curl -s -X PUT $BASE/marks -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"items":[{"id":"<id>","stars":3},{"id":"<id2>","stars":0}]}'
# → 每项 { ok, stars, del, error }；409 = 全部失败，看 results 里逐项原因
```

**循环无状态、无租约**（历史决策 009 决定：不做 claim/lease）——两个 agent 撞车最多同一张写两次，`marks.jsonl` 留痕后写覆盖，能收敛。要「领一批」的确定性，用任务层（§4）。

## 3. 语义与坑（读一遍少踩一轮）

- **`by` / `channel` 自动打标**：Bearer → `ai:<token label>` + `api`；链接 token → `link:<批注人>`；浏览器 → `me` + `inapp`。想自定义可以在 item 里带 `by`，一般不必。
- **`GET /photos` 默认滤掉待删**：数待删必须 `sel=del`（或 `sel=all`）。
- **`dir` 只列直属照片**，不递归；要递归先 `GET /folders?path=…` 走树。
- **id 是稳定 base64**（rootId + 相对路径派生），文件改名/移动 = 换 id；`displayName` 才是给人看的。
- **RAW+JPEG 是一个实体**（同目录同 stem 配对）：标一次、动一次，成对处理。
- **XMP 写失败不报错**：网络盘只读时标注仍落在 `marks.jsonl`（`dataDir`），界面可见的星级以它为准；照片旁的 `.xmp` 会在盘可写后被带上（重启重扫时对齐）。
- **缩略图分档**：`512`（列表）/`2048`（细看）。响应没有 content-length，判断字节用 body 长度。
- **礼貌并发**：缩略图按需生成（首扫后逐张缓存），批量拉图请限并发（≤4 稳妥）；`/photos` 轮询别短于 2s。
- 全量自描述：`GET /api/v1/capabilities`（jobs/channels/executors/library/notes —— `library.cache` 是预览缓存账本，`library.autoRescan` 是索引新鲜度）。

## 4. 顺带给人类派活：批注任务

agent 也可以**派**批注任务给人（飞书等出站通道 v1 未开，先用应用内链接）：

```bash
# plan：只展开 items 快照看张数（不落库不签 token）
curl -s -X POST $BASE/jobs -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{
  "mode": "plan", "kind": "annotate",
  "selection": { "project": "test", "where": { "marked": false } },
  "params": { "label": "小张" } }'

# apply：真建任务 → artifacts 里有批注链接（/j?t=<范围 token>，免登录）
# 同上，把 "mode":"plan" 去掉（或改 "apply"）

# 盯进度（增量轮询，seq 单调递增，nextSince 当游标）
curl -s "$BASE/jobs/<jobId>/events?since=<seq>" -H "authorization: Bearer $TOK"
```

回流（批注人通过链接写回）自动 `by: 'link:<批注人>'`、`clientRef` 幂等；对账用 `GET /marks/history?jobId=<jobId>`。

## 5. 环境速查

| 项 | 值 |
|---|---|
| 本机开发 | `http://127.0.0.1:8787/api/v1`（`server/tools/dev.sh start`） |
| 认证 | `password` 为空 = 免认证（仅本机开发形态）；设了密码则 Bearer 必带 |
| 部署 | Docker / systemd 见根 `README.md`「部署」节；Tailscale 直连，不加反代 |
| 契约 | `contracts/openapi.yaml`（唯一线格式）；选择集语法 `contracts/selection.md` |
