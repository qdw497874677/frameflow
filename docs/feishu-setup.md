# 飞书连接器部署说明（F30）

> 状态：本地离线测试（假 SDK / 假传输）全部通过；**真实飞书平台尚未联调**，待用户提供专用测试应用、目标与发送许可后按 F33 验收。

## 1. 创建专用应用

1. 在飞书开放平台创建**企业自建应用**，仅用于 FrameFlow；不要复用已有业务机器人。
2. 开启「机器人」能力。
3. 权限（最小集，按需申请）：
   | 权限 | 用途 |
   |---|---|
   | `im:message:send_as_bot` | 发送任务入口卡、测试卡、完成通知 |
   | `im:message.group_at_msg:readonly` | 群内 @机器人 的文本命令（「任务」等） |
   | `im:message.p2p_msg:readonly` | 私聊文本命令 |
   | `im:resource` | 上传预览图；显式请求时上传原图 JPEG（F28） |
   不需要通讯录、云文档、审批等权限；不申请「获取群组中所有消息」。
4. 事件与回调：订阅方式选**长连接**（WebSocket，后端主动外连，无需公网回调地址）。
   - 事件：`im.message.receive_v1`
   - 回调：`card.action.trigger`（卡片交互）
5. 发布版本并由管理员审批；把机器人拉进**专用测试群**。

## 2. Secret 与配置

- App Secret **只放在环境变量**，配置里只写变量名（`secretEnv`），例如：
  ```bash
  export FRAMEFLOW_FEISHU_SECRET='…'   # 不要写进 config.json、仓库或日志
  ```
- 网页「设置 → 飞书连接器」新建实例：App ID、Secret 环境变量名、tenant_key、目标（群 `oc_…` / 用户 `ou_…`）、允许用户与授权项目。新建默认**停用**，保存不发送任何消息。
- 必须先设置应用密码（`password`），否则连接器管理整体禁用（后端 403 `PASSWORD_REQUIRED`）。

## 3. 网页可达性

- 飞书卡片里的「打开网页」链接指向 FrameFlow 自身地址；成员需能访问该地址（内网 / VPN / 你自己配置的反向代理）。
- **FrameFlow 不会自动开放公网端口**，也不需要公网回调（长连接外连）。是否暴露到公网由部署者自行决定并自行加 TLS 与访问控制。

## 4. 验证顺序（逐步放量）

1. 启用实例 → 状态应为「运行中」；出错时如实显示错误码。
2. 点「**无消息验证**」：只取 tenant_access_token，**不发送消息**。
3. 点「**发送测试卡…**」：展示目标 → 再点「确认发送测试卡」才真实发送一张不含照片/任务信息的测试卡。
4. 命令行等价（默认不联网）：
   ```bash
   cd server
   node tools/feishu-live-check.mjs --help
   FEISHU_LIVE_APP_ID=cli_xxx FEISHU_LIVE_SECRET_ENV=FRAMEFLOW_FEISHU_SECRET \
     node tools/feishu-live-check.mjs --live --i-understand-network
   # 发送测试卡还需：--send-test-card --chat-id=oc_xxx --i-understand-sending
   ```
5. 用一个小项目做一次外传派发，确认入口卡、复核卡、完成通知与网页确认进度一致。

## 5. 外传与 unknown 提示

- 每次外传都要预览 + 显式确认；预览展示目标、照片数、是否含原图（默认不含）与完成通知范围。
- 发送结果为 **unknown**（超时、网络中断）时，消息**可能已送达**；重试需二次确认「接受重复风险」。不要批量重试 unknown。

## 6. 备份与回滚

数据都在 `dataDir`：

| 文件 | 内容 |
|---|---|
| `connectors.json` | 连接器实例与目标（不含 Secret） |
| `delivery-policies.json` | 投递策略 |
| `delivery-confirmations.jsonl` | 外传确认与追加目标记录 |
| `deliveries.jsonl` | 投递账本（幂等键） |
| `feishu/sessions.jsonl`、`feishu/actions.jsonl`、`feishu/cursors.jsonl`、`feishu/jpegs.jsonl` | 飞书会话、动作去重、游标、原图请求 |

步骤：

1. **升级前**停服务，备份整个 `dataDir`（至少上表文件与 `marks` 日志）。
2. **紧急停止外传**：在网页把实例「停用」（立即停长连接，排队消息执行时重新授权会被拒绝）；或撤掉 Secret 环境变量后重启。
3. **回滚版本**：停服务 → 换回旧版本 → 恢复备份的 `dataDir` → 启动。旧版本忽略未知的连接器文件；标注日志兼容性见 `docs/marks-log-compatibility.md`。
4. 在飞书开放平台停用应用或重置 App Secret 可彻底切断。
