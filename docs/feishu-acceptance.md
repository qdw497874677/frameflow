# 飞书连接器验收记录（F32）

结论：**实现/本地验收完成，飞书实测阻塞**（FC-07 需 F33：用户提供专用应用、测试目标与发送许可）。
所有证据均为离线：假 SDK / 假传输、临时库与临时 dataDir，零真实凭据、零真实发送。未通过或缺人工证据的条目不勾选。

## 本次执行（Node 22.20，最终代码版本）

| 命令 | 结果 |
| --- | --- |
| `(cd server && node --test tools/*.test.mjs)` | 130 pass / 0 fail（含 connector-recovery 8 项） |
| `(cd server && node tools/e2e-marks-durability.mjs)` | 3 pass |
| `(cd server && node tools/e2e-jobs.mjs)` | 81 通过 / 0 失败 |
| `(cd server && node tools/e2e-annotate.mjs)` | 94 通过 / 0 失败 |
| `node tools/e2e-connectors.mjs --scenario=all` | 6 场景全过：settings、test-send、dispatch、delivery、progress、redispatch（390px 真实浏览器） |
| `node tools/e2e-project-navigation.mjs` | PASS（1440×900，真实鼠标点击） |
| `npx tsc --noEmit`、`web: npm run typecheck`、`npm run build` | 通过 |
| `npm audit` | server：2（1 low、1 moderate，fastify/fast-uri）；web：8（2 moderate、6 high，开发依赖链 undici/zod/@shadcn）。未在本票升级依赖，需单独评估 |

注：本环境无 `chromium` 命令，导航回归用指向 google-chrome 的同名垫片运行。

## 按规格编号

| 编号 | 状态 | 证据 |
| --- | --- | --- |
| CC-01 | [x] | connector-core/connector-runtime.test（双实例独立、同 appId 拒绝）；F21 |
| CC-02 | [x] | connector-api/connector-storage.test（无 Secret 回显、未知环境变量诊断）；e2e settings |
| CC-03 | [x] | connector-api.test（未认证/范围 token/未设密码 403）；e2e settings |
| CC-04 | [x] | feishu-interaction/feishu-commands.test（跨实例、跨租户、转发卡片拒绝且零写入） |
| CC-05 | [x] | connector-storage.test（原子替换）；connector-recovery.test（重启不假 connected） |
| CC-06 | [x] | feishu-interaction.test（撤权后旧卡失效）；connector-recovery.test（停用后重试零外传） |
| CC-07 | [x] | e2e test-send（假 SDK 日志：无消息验证 0 条，测试卡仅 1 条到所选目标）；feishu-live-check 默认拒绝 |
| CC-08 | [x] | feishu-commands.test（授权创建者首次创建 / 普通用户拒绝） |
| CC-09 | [x] | feishu-interaction/feishu-commands.test（canAnnotate=false 按钮/命令均不写，排队后撤权不写） |
| DP-01 | [x] | delivery-policy.test；e2e dispatch（取消/失效预览零发送） |
| DP-02 | [x] | delivery-policy.test（去重、删掉的目标不发） |
| DP-03 | [x] | delivery-runner.test；e2e delivery（两实例三目标、单目标重试、unknown 需确认） |
| DP-04 | [x] | delivery-confirmation.test；connector-recovery.test（各中断点重启对账） |
| DP-05 | [x] | delivery-policy/delivery-api.test（策略变更、移除照片、撤权冲突） |
| DP-06 | [x] | delivery-api.test（完成通知去重，追加目标不重复）；e2e redispatch |
| DP-07 | [ ] | 自动化：390px 下 dispatch/delivery/progress/redispatch 可操作、无横向溢出、主按钮≥44px、aria-live 状态断言通过。**缺人工键盘/读屏走查**，待人工审核后勾选 |
| DP-08 | [x] | delivery-runner.test（入口成功卡片失败只恢复未成功部分）；connector-recovery.test |
| FC-01 | [x] | feishu-connector/feishu-sdk-probe.test（独立生命周期、国内域名、停用关连接、无明文泄漏） |
| FC-02 | [x] | feishu-connector/feishu-interaction.test（回调适配、慢业务 3 秒内受理） |
| FC-03 | [x] | feishu-connector.test（仅预览上传、超限/空文件/RAW-only 拒绝、JPG hash 一致） |
| FC-04 | [x] | feishu-connector.test（open_id/chat_id 映射、跨应用不复用 key） |
| FC-05 | [x] | feishu-connector/delivery-runner.test（失败/限流/超时 unknown、uuid 稳定、无无限重试）；connector-recovery.test（迟到成功） |
| FC-06 | [x] | feishu-interaction.test（超期卡片、无效 token、已删消息提示，更新失败不伪造） |
| FC-07 | [ ] | **阻塞**：需 F33 真实应用实测。仅有"本地测试通过" |
| FI-01 | [x] | feishu-interaction.test；e2e progress（重标不重复计数） |
| FI-02 | [x]（本地） | feishu-commands.test（群未@忽略、未知命令只帮助）；平台侧待 F33 |
| FI-03 | [x]（本地） | marks-transaction/feishu-interaction.test（旧版本最多一项成功）；平台侧待 F33 |
| FI-04 | [x] | marks-generation/feishu-interaction.test；connector-recovery.test（持久化边界故障注入） |
| FI-05 | [x] | feishu-interaction/job-gates.test（重标有历史、撤销后旧卡无写入、失联阻塞） |
| FI-06 | [x] | feishu-interaction.test（身份取自事件、跨目标拒绝） |
| FI-07 | [x]（本地） | feishu-interaction/feishu-connector.test（显式 JPEG 只发当前目标、重复回调无重复附件）；平台侧待 F33 |
| FI-08 | [x]（本地） | feishu-interaction.test（未确认不写、草稿隔离、落盘后才出成功卡）；平台侧待 F33 |
| FI-09 | [x] | e2e-jobs、e2e-annotate、e2e-marks-durability、e2e-project-navigation 均通过；无破坏性迁移 |

## 待人工审核

- DP-07 键盘与读屏走查（桌面与 390px）。
- 外发提示文案、飞书权限申请范围、`unknown` 状态提示文案。
- 依赖审计告警是否升级。
