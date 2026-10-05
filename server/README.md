# server（后端）

**状态：未实现。** 语言与运行形态见 `wayfinder/tickets/005-stack-deployment.md`（待定票）。
本文件先固定**模块边界**与职责，避免前端/后端职责漂移。

## 职责边界

后端是唯一接触磁盘的进程。前端（`web/`）不做任何文件系统访问，只通过 `contracts/openapi.yaml` 的 HTTP API 交互。

## 内部模块（各自独立、可单独测试）

| 模块 | 职责 | 关键约束（来自已关闭的票） |
|---|---|---|
| `scan` | 目录遍历、照片发现、RAW+JPEG **配对** | 同目录 + stem 大小写不敏感相等 + 扩展名分类；多 RAW 取字母序最早；每次扫描重建配对（票 001） |
| `preview` | 分层预览管线：外部 JPEG → 内嵌 JPEG 提取 → LibRaw 兜底 | 512 / 2048 两档缓存，缓存键 `path+mtime+size`；内嵌 JPEG 缺 Orientation 需回填（票 001） |
| `marks` | 星级 / 待删的持久化 | 星级写共享 XMP（`xmpDM:good`，与 LR/C1 互通）；pair 为一等实体，成对写入（票 001） |
| `trash` | 逻辑删除区（产品回收站） | 删除 = 移入产品回收站，可恢复；pair 成对进出（票 001 + 用户决策）；`dir/.trash` 下的文件**不参与扫描配对** |
| `roots` | 根目录列表与在线检测 | 多根（本地盘/挂载点）；`online=false` 表示当前不可访问，前端只灰显不报错（票 004） |
| `auth` | 单用户认证与会话 | 家用 + Tailscale 场景下的最简方案（票 005） |
| `httpapi` | HTTP 层：路由、序列化、错误码 | 严格实现 `contracts/openapi.yaml`；不含业务逻辑，只做编解码与调用 |

## 前端已经依赖的接口

前端已完成（`web/`），它按 `contracts/openapi.yaml` 调用以下端点；后端照此实现即可跑起来：

`GET /health`、`POST|DELETE /session`、`GET /roots`、`GET /folders`、`GET /photos`、`GET /photos/{id}/thumb|file`、`PUT /marks`、`GET|POST|DELETE /trash`、`POST /trash/restore`。

三条后端必须自己保证的语义（前端已按此编写，且 mock 实现里可见）：

1. `PUT /marks`：`stars > 0` 与 `del = true` 互斥，同时给出时以 `del` 为准；按 pair 写入共享 XMP。
2. `POST /trash` 只是移入产品回收站（可还原）；`DELETE /trash?confirm=true` 是**唯一**删磁盘文件的入口，`ids` 为空 = 清空回收站。
3. 应用不导入、不导出、不搬动照片：除了写星标与回收站操作，**不碰原文件**。

## 不变式

1. **磁盘是真相**：不建媒体库、不复制导入；数据库（若有）只是索引/缓存，永远可重建。
2. **成对原子**：RAW+JPEG 配对在打标、删除上永远一起行动。
3. **只有两处写磁盘**：星标/待删（XMP）与回收站（移入 `.trash` / 还原 / 真删）。
4. **可重建**：预览缓存与索引删除后，重扫即可恢复。
