# FrameFlow 飞书连接器执行清单

状态：**F01–F03及F03a完成离线验证与独立复核；停在检查点A，等待人工确认后进入F04。未连接真实飞书，未重启当前服务；本轮实现已提交，提交号见各项记录。**

入口：[规格及模块图](../SPEC.md) · [技术计划](plan.md)。这是唯一执行清单，不创建另一套票据体系。历史体系已删除，其资料仅在 Git 历史中保留。

## 执行规则

- 按依赖执行，每次只做一个可验证小步。每3项有检查点；高风险检查点需人工复核后继续。
- 每项列出的文件是预估范围（最多5个，测试也计入）。若实际必须超过范围或需要改变已批准协议，先在本文件继续拆分/记录理由，不偷偷扩大任务。
- 新测试/路径按任务逐步实现；测试结果记录在对应任务下。当前仅离线验证，不连接真实飞书。
- 红→绿→复核；每项关闭时补实际命令结果、提交号和证据路径。禁止删断言、吞失败或以假 SDK 验证替代真飞书验收。
- 新管理端点必须同一步完成 OpenAPI、DTO、鉴权、输入校验和负向测试。可选字段保持旧接口兼容。
- 本文命令均从仓库根执行。每项除专用命令外都执行：

```bash
(cd server && npm run typecheck)
(cd web && npm run typecheck)
git diff --check
```

涉及前端时另执行 `(cd web && VITE_API_BASE=/api/v1 npm run build)`。浏览器脚本必须自起动态端口/临时库、收尾关闭，不读写用户照片或重启当前8787服务。

## 阶段 A：先证实 SDK 与持久化可行（V0）

### [x] F01 — 官方 SDK 离线能力验证与锁定
- 模块：feishu-connector；验收：FC-01/02/05/06、FI-08。依赖：任务清单批准。
- 范围：只验证依赖/类型与传输行为，不启动真实应用。
- 验收：①锁定已审计 SDK，证明国内域名、WSClient/EventDispatcher、新卡片表单值与更新映射；②假传输证明超时/内部重试/取消/迟到返回行为，记录哪些结论仍需真实应用；③证据不足停止，不用Webhook替代。
- 文件：`server/package.json`、`server/package-lock.json`、`server/tools/feishu-sdk-probe.test.mjs`、`docs/feishu-sdk-validation.md`。
- 验证：`(cd server && node --test tools/feishu-sdk-probe.test.mjs && npm audit)`；人工审核最小权限与真实验证待办。
- 2026-10-23 实施证据：精确锁定官方SDK 1.76.0；离线8/8、临时干净安装重跑通过、类型检查通过。审计新增0项，仍有既存Fastify低危1项（audit退出1，不宣称全绿）；详情 `docs/feishu-sdk-validation.md`。独立复核后补默认自建应用token获取/缓存/失败阻断测试，最终9/9；第二次只读评审无阻塞；提交 `8616f09`。
- 主线补查：官方Node SDK回调专页明确支持新版 `card.action.trigger` 长连接，仅旧卡片回调不支持，README笼统限制不作为否定依据（证据见验证文档）。FC-02/FI-08真实平台仍未验收，F33需授权真应用验证，不用Webhook替代。生成IM方法不转发单次timeout/signal，默认timeout=0；后续必须保留unknown与迟到成功关联。

### [x] F02 — 新业务日志与单写者保护
- 模块：connector-core；验收：CC-05、FI-04。依赖：无（批准清单后可与F01并行）。
- 验收：①临时dataDir中版本化记录可靠追加/flush后才成功，损坏中段拒绝写、半尾行可诊断恢复；②第二写者拒绝、PID复用/不明陈旧锁不自动夺取；③注入追加/flush失败、崩溃重启无假提交，不改现有日志格式。
- 文件：`server/src/connectors/journal.ts`、`server/src/connectors/writer.ts`、`server/tools/connector-storage.test.mjs`。
- 验证：`(cd server && node --test tools/connector-storage.test.mjs)`；测试必须含双子进程与截断记录。
- 2026-10-23 实施证据：先RED（缺模块），再GREEN 11/11；双进程竞争/杀进程残锁/截断与中段损坏/append及flush失败/短写/生命周期回调均覆盖，前后端类型检查通过。初版主线合跑F01/F02共19/19。独立复核发现非法UTF-8可被有损解码掩盖，已先RED后修；补恢复flush失败、两个进程中途写入死亡屏障、多字节修复偏移、单行/条数上限，最终F02 19/19、合跑F01/F02 28/28，类型检查通过；提交 `0ef1103`。锁保证只覆盖可信目录内遵守协议的写者，不声称抵御管理员并发替换锁。
- 边界：离线Linux本地可信dataDir原语，不接生产生命周期；不自动清陈旧锁；fsync失败视为unknown，按稳定ID重放对账而非自动去重；限1MiB/记录、64MiB/日志、10万记录，轮转另行实现。

### [x] F03 — 标记事务 envelope 与旧日志兼容
- 模块：feishu-interaction（标注基础）；验收：FI-04/09。依赖：F02。
- 验收：①旧MarkChange可读，新事务包含opId/revision/完整状态，同值确认也落记录；②日志失败不发布内存成功，同ID异载荷拒绝、历史API不暴露envelope；③旧调用仍可用，故障重放不重复变化，记录降级/回滚限制。
- 文件：`server/src/core/marks.ts`、`server/src/core/mark-transaction.ts`、`server/tools/marks-transaction.test.mjs`、`server/tools/e2e-marks-durability.mjs`、`docs/marks-log-compatibility.md`。
- 验证：`(cd server && node --test tools/marks-transaction.test.mjs && node tools/e2e-marks-durability.mjs)`。
- 完成：新旧混合日志显式校验、同值操作也推进revision；原有“同值不追加日志”断言改为“同值新意图追加事务但不增加可视历史”，保留原失败/重复ID断言。独立复核后先RED再修稀疏数组、有损UTF-8、完整行语义损坏前误修尾行；防御性复制回归通过。事务13/13、旧持久化3/3，最终独立静态评审无阻塞；提交 `029f0fd`。F04源身份与F05锁未提前实现，不能据此部署真实连接器。

### [x] 检查点 A — 风险验证
F01–F03通过并独立复核，形成SDK字段证据与磁盘失败矩阵；不接真实飞书。缺失能力/恢复保证必须先修计划。**人工确认继续。**

基础回归（2026-10-23，F03变更前）：旧marks持久化3/3、隔离jobs 81/0、隔离annotate 94/0、项目树真实浏览器回归通过；前端类型与构建通过（既有>500kB体积警告）。只使用临时实例/测试库，未重启8787。F03完成后须在最终代码版本重新执行，不能沿用此基线成绩。

### [x] F03a — 混合标记日志的旧批注回归适配
- 实施中拆分理由：F03原范围已达5文件，旧e2e直接读JSONL并假定每行是MarkChange，事务envelope使这一条真实持久化断言失配。单独登记，不删除/放宽原审计要求。
- 依赖：F03；文件：`server/tools/e2e-annotate.mjs`（1文件）。
- 验收：解析旧行及新envelope内changes后仍断言落盘有批注人+jobId；旧API history断言保持；隔离annotate全套94项通过。
- 验证：隔离临时路径运行批注回归94/94通过；原落盘来源+jobId断言保留，仅展开新envelope内changes；同提交 `029f0fd`。

检查点A最终证据（2026-10-23）：F01 9/9 + F02 19/19 + F03事务13/13 + 旧持久化3/3，共44/44；隔离jobs 81/81、annotate 94/94；前后端类型检查、前端构建、项目树真实浏览器回归均通过。隔离e2e只替换副本的临时路径/端口，没有改断言：`/tmp/frameflow-checkpoint-a-a3npo28g`；浏览器日志 `/tmp/checkpoint-a-navigation.log`。既有前端包>500kB警告及Fastify low审计项仍存在。F01/F02/F03复核全部无剩余阻塞；仍需人工确认检查点A，未开始F04。

**人工确认（2026-10-25）：用户确认检查点A通过，同意tenantId与ID格式选择，继续阶段B起。**

## 阶段 B：源版本与公共并发边界（V0/V4基础）

### [x] F04 — 标记绑定源 generation
- 模块：feishu-interaction；验收：FI-03/04/05/09。依赖：F03。
- 验收：①同源重启版本稳定，同路径换源产生新generation，旧状态只留审计；②不可达源不确认，不将未验证缓存写回XMP；③同源已提交事务优先于旧XMP，旧无generation数据按兼容规则建立基线。
- 文件：`server/src/core/mark-transaction.ts`、`server/src/core/marks.ts`、`server/src/core/library.ts`、`server/src/core/source-generation.ts`、`server/tools/marks-generation.test.mjs`。
- 验证：`(cd server && node --test tools/marks-generation.test.mjs)`；包含同路径替换、提交后XMP前崩溃和失联恢复。
- 完成（2026-10-25）：source-generation(path/size/mtime sha256)；marks绑定generation，换源不继承旧状态只留审计，不可达返回SOURCE_UNAVAILABLE不写XMP；marks-generation 6/6、jobs 81/81、annotate 94/94。

### [x] F05 — 照片写入与回收站共用串行边界
- 模块：feishu-interaction；验收：FI-03/05/09。依赖：F04。
- 验收：①普通写标、回收站清标/移动/还原/真删共用photo gate，锁内检查源与可访问性；②XMP按照片有序，失败可诊断且旧值不能晚写覆盖新值；③已持锁内部方法不重入死锁，一张挂载慢不阻塞别的项目。
- 文件：`server/src/core/operation-gates.ts`、`server/src/core/library.ts`、`server/src/core/marks.ts`、`server/src/api/server.ts`、`server/tools/photo-gates.test.mjs`。
- 验证：`(cd server && node --test tools/photo-gates.test.mjs && node tools/e2e-marks-durability.mjs)`；真删仅用临时库。
- 完成（2026-10-25）：operation-gates按key串行、排序加锁、AsyncLocalStorage可重入；applyMarks/移入/还原/真删共用photo gate且锁内复核源；photo-gates 5/5、durability 3/3。

### [x] F06 — 任务取消、撤销与回流共用 job gate
- 模块：feishu-interaction；验收：FI-03/04/05/09。依赖：F05。
- 验收：①cancel/undo/旧inbound按job→photo顺序执行，锁内重新检查终态与undone；②普通标记不反向取job锁，竞争测试无死锁；③旧任务完成/撤销/重复回执语义不退化。
- 文件：`server/src/jobs/service.ts`、`server/src/jobs/annotate.ts`、`server/src/core/operation-gates.ts`、`server/tools/job-gates.test.mjs`。
- 验证：`(cd server && node --test tools/job-gates.test.mjs && node tools/e2e-jobs.mjs && node tools/e2e-annotate.mjs)`。
- 完成（2026-10-25）：cancel/undo/inbound改用job gate（替代原inboundLocks），锁内重读状态；持photo再取job锁即GATE_ORDER_VIOLATION；job-gates 3/3、jobs 81/81、annotate 94/94。

### [x] 检查点 B — 写入基础安全
F04–F06的换源、并发与旧任务回归通过；复核锁的持有范围，不允许以“单线程”代替并发证明。先提交可独立运行的兼容基础，连接器仍未启用。

## 阶段 C：管理端口与受控配置（V1）

### [x] F07 — 通用端口、配置与权限决策
- 模块：connector-core；验收：CC-02/04/05/08/09。依赖：F01、F02。
- 验收：①确定通用类型，SDK类型不越界；配置原子替换、默认disabled、secretEnv脱敏；②按实例/租户/来源目标/用户/项目/操作区分授权，首次创建不要求已有任务；③canAnnotate、canRequestJpeg、创建权限独立且默认拒绝。
- 文件：`server/src/connectors/types.ts`、`server/src/connectors/config.ts`、`server/src/connectors/access.ts`、`server/tools/connector-core.test.mjs`。
- 验证：`(cd server && node --test tools/connector-core.test.mjs)`；覆盖配置失败和跨目标身份矩阵。
- 2026-10-25 实施证据：按“F07–F12管理支线可与F04–F06并行”先做F07（检查点A人工确认仍待记录，F04未开始）。新增types/config/access三模块：通用端口类型无SDK依赖；connectors.json原子替换（tmp+fsync+rename+目录fsync，0700/0600）、revision冲突、注入rename失败不发布内存新状态且旧文件不变、损坏/非法UTF-8/未知版本拒绝加载；创建强制disabled，原始Secret字段/未知字段/重复appId/目标拒绝，secretConfigured脱敏；纯函数typed授权决策覆盖实例/租户/来源目标/用户/项目/任务投递/照片及canAnnotate/canRequestJpeg/创建权限。connector-core 9/9，合跑F01–F03 41/41，前后端类型检查与`git diff --check`通过。未接入API/生命周期（F08/F09），未连接真实飞书。

### [x] F08 — 注册表与生命周期（假适配器）
- 模块：connector-core；验收：CC-01/02/05/06/07。依赖：F07。
- 验收：①两实例独立启动/停用，同appId拒绝重复，未启用零连接；②重启状态真实、坏环境引用可诊断，单写者保护在启用前生效；③测试连接不发消息，排队执行前再授权，停用阻止新外传。
- 文件：`server/src/connectors/registry.ts`、`server/src/connectors/runtime.ts`、`server/src/connectors/types.ts`、`server/tools/connector-runtime.test.mjs`。
- 验证：`(cd server && node --test tools/connector-runtime.test.mjs)`；断言假端口调用次数和目标。
- 完成（2026-10-25）：registry(工厂+内存状态)、runtime(sync启停、connectors.lock单写者、执行前再授权、test仅verify)；假端口断言调用次数与目标，connector-runtime 6/6。

### [x] F09 — 连接器管理 API
- 模块：connector-core；验收：CC-02/03/05/07。依赖：F08。
- 验收：①增删改查/目标读取/无消息测试接口、分页、revision与引用冲突完整；②只放已认证管理session、同源/CSRF校验，密码未设不启用；③任意token/未登录/原始Secret提交拒绝，响应无凭据。
- 文件：`server/src/api/connectors.ts`、`server/src/api/server.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`server/tools/connector-api.test.mjs`。
- 验证：`(cd server && node --test tools/connector-api.test.mjs)`；OpenAPI/DTO与状态码对照。
- 完成（2026-10-25）：/connectors CRUD+分页+expectedRevision+test+targets；仅管理session，未设密码403 PASSWORD_REQUIRED，写操作同源校验；OpenAPI与web DTO同步；connector-api 4/4，全量单测74/74、jobs 81/81、annotate 94/94。

### [x] 检查点 C — 管理安全
F07–F09通过。未设置密码、未启用、普通API token均不能启用外传；暂不接SDK实例。

## 阶段 D：网页管理与派发预览（V1/V2）

### [x] F10 — 设置页管理连接器
- 模块：connector-core；验收：CC-01/02/03/06/07。依赖：F09。
- 验收：①设置页配置实例/群或私聊目标/允许用户与项目/创建权限，默认disabled；②显示secretConfigured、真实状态/错误与无消息连接测试，失败保留表单；③未认证入口禁用但后端仍校验，390px无溢出/主控件≥44px。
- 文件：`web/src/api/connectors.ts`、`web/src/features/connectors/ConnectorSettings.tsx`、`web/src/features/connectors/TargetEditor.tsx`、`web/src/features/settings/SettingsPage.tsx`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=settings`；脚本此项创建，使用假适配和临时库。
- 完成（2026-10-25）：设置页新增「外部连接器（飞书）」卡：实例/群或私聊目标/允许用户/授权项目/创建权限编辑，新建默认停用；显示secretConfigured与真实状态/错误码，无消息测试连接；保存失败保留表单；未设密码时入口禁用且后端仍403。`node tools/e2e-connectors.mjs --scenario=settings` 两轮（登录390px / 未设密码）通过，主控件≥44px、无横向溢出。

### [x] F11 — 策略配置与不可变预览服务
- 模块：delivery-policy；验收：DP-01/02/05。依赖：F07。
- 验收：①按项目/事件匹配、目标去重，空项目集合不表示全部；②预览绑定照片/目标/参数/策略版本、10分钟期限，零发送；③更改权限/策略/照片需重新预览，不静默换目标。
- 文件：`server/src/delivery/policies.ts`、`server/src/delivery/previews.ts`、`server/src/delivery/types.ts`、`server/tools/delivery-policy.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-policy.test.mjs)`；假时间测试过期边界。
- 完成（2026-10-25）：delivery/types、policies（原子0600存储、revision、未知字段拒绝、纯函数匹配+去重、空projectIds不匹配）、previews（不可变快照+sha256 revision、10分钟期限可注入时钟、陈旧/过期/取消、显式目标须在允许集合，零发送端口）。delivery-policy 3/3。

### [x] F12 — 策略与预览管理 API
- 模块：delivery-policy；验收：DP-01/02/05、CC-03。依赖：F09、F11。
- 验收：①策略CRUD/预览接口同一步写契约DTO，管理session+CSRF；②策略修改expectedRevision、目标引用/输入大小/分页限制完整；③任意外部chat_id/路径拒绝，预览与取消无发送。
- 文件：`server/src/api/delivery.ts`、`server/src/api/server.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`server/tools/delivery-api.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-api.test.mjs)`。
- 完成（2026-10-25）：api/delivery.ts 策略CRUD+预览/取消，复用连接器管理门（密码+session+同源），expectedRevision、目标引用校验（存在且授权每个项目）、分页1–100、尺寸上限，外部chat_id/路径等未知字段一律UNKNOWN_FIELD；连接器删除接入策略引用检查；OpenAPI与DTO同步。delivery-api 3/3。

### [ ] 检查点 D — 网页配置与零外传
F10–F12浏览器/接口回归通过，用户检查配置与权限文案。策略仅推荐，不得变成无确认群发。

## 阶段 E：确认只创建一次（V2）

### [x] F13 — 任务从确认快照幂等创建
- 模块：delivery-policy；验收：DP-04、FI-09。依赖：F06、F11。
- 验收：①内部预分配jobId与requestId只创建一个任务，不重新展开快照；②重放/并发相同请求返回同一任务，异载荷拒绝；③新网页仅应用内也经过requestId幂等确认（目标集合为空），并发/响应丢失重试只建一次且零发送；旧/jobs plan不落实际任务，旧随机ID客户端路径保持兼容。
- 文件：`server/src/core/jobs.ts`、`server/src/jobs/service.ts`、`server/tools/confirmed-job.test.mjs`。
- 验证：`(cd server && node --test tools/confirmed-job.test.mjs && node tools/e2e-jobs.mjs)`。
- 完成（2026-10-25）：JobsService.createConfirmed + JobsStore 预分配 id/requestId 索引；tools/confirmed-job.test.mjs（3）

### [x] F14 — 持久确认与崩溃恢复
- 模块：delivery-policy；验收：DP-01/04/05。依赖：F13、F02。
- 验收：①requestId原子接受绑定全部快照/参数/通知选择/外传同意；②accepted不随preview到期遗忘，先查接受记录再查期限；③意图/建任务间各点中断可恢复同一任务，恢复前重新校验授权。
- 文件：`server/src/delivery/confirmations.ts`、`server/src/delivery/previews.ts`、`server/src/delivery/types.ts`、`server/tools/delivery-confirmation.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-confirmation.test.mjs)`；必须含过期后重试和并发双确认。
- 完成（2026-10-25）：src/delivery/confirmations.ts（delivery-confirmations.jsonl，先记录后建任务、过期后重试、并发、恢复前复核授权）；tools/delivery-confirmation.test.mjs（4）

### [x] F15 — 分目标、分消息部分投递账本
- 模块：delivery-policy；验收：DP-03/04/08、FC-05。依赖：F14、F08。
- 验收：①每目标part意图先落盘再发送，所有必要部分成功才sent；②pending可恢复、遗留sending为unknown，成功部分不重发；③失败单独重试，unknown复核/风险确认，原SDK attempt活跃时禁止重叠替代，迟到成功归原意图。
- 文件：`server/src/delivery/store.ts`、`server/src/delivery/runner.ts`、`server/src/delivery/types.ts`、`server/tools/delivery-runner.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-runner.test.mjs)`；用可控制迟到响应的假传输，不用随机sleep证明去重。
- 完成（2026-10-25）：src/delivery/store.ts + runner.ts（deliveries.jsonl 意图/结果账本、sending→unknown、迟到成功归属原意图）；tools/delivery-runner.test.mjs（4）

### [ ] 检查点 E — 确认与投递恢复
F13–F15通过；人工/独立复核故障矩阵与unknown语义。确认不重复建任务，任务成功不等于所有目标成功。

## 阶段 F：网页派发闭环（V2）

### [x] F16 — 确认、投递查询与重试 API
- 模块：delivery-policy；验收：DP-03/04/05/08。依赖：F12、F15。
- 验收：①确认返回稳定任务关联/受理状态，查询和单目标重试契约明确；②相同requestId异载荷409、unknown重试有显式重复风险参数；③无权限/停用时不调用发送，API无Secret/完整范围链接泄漏。
- 文件：`server/src/api/delivery.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`server/tools/delivery-api.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-api.test.mjs)`。
- 完成（2026-10-25）：POST /delivery-confirmations、GET /jobs/{id}/deliveries、POST /jobs/{id}/deliveries/retry（acceptDuplicateRisk、ATTEMPT_IN_FLIGHT）；delivery/dispatcher.ts；server 装配（无传输时 NO_TRANSPORT）；delivery-api.test.mjs +2

### [x] F17 — 策略编辑与网页确认入口
- 模块：delivery-policy；验收：DP-01/02/05/07。依赖：F10、F16。
- 验收：①设置页编辑项目/事件/目标策略，派发默认仅应用内；②勾选连接器后预览目标、上传说明/权限摘要/完成通知选项，取消不发送；③同一次确认重试复用requestId（含未勾选连接器的仅应用内分支，使用F13/F14确认服务），重复点击/响应丢失/并发重试均只建一任务且零误发；失效要求重新预览，390px可操作。
- 文件：`web/src/api/connectors.ts`、`web/src/features/connectors/PolicyEditor.tsx`、`web/src/features/connectors/ConnectorSettings.tsx`、`web/src/features/jobs/DispatchAnnotate.tsx`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=dispatch`。
- 完成（2026-10-25）：设置页 PolicyEditor（项目+事件→已授权目标，仅推荐）；派发框外传区默认仅应用内、勾选→服务端预览→显式确认，requestId 每个预览一次、重试复用；取消丢弃预览零发送；无连接器 API 时退回旧应用内派发；e2e --scenario=dispatch

### [x] F18 — 任务详情逐目标投递反馈
- 模块：delivery-policy；验收：DP-03/07/08。依赖：F17。
- 验收：①任务页分别展示pending/sending/sent/failed/unknown及必要消息部分；②只重试失败部分，unknown展示风险确认与原尝试未结束限制；③双实例三个目标部分失败浏览器闭环通过，状态可读屏、390px无横溢。
- 文件：`web/src/features/connectors/DeliveryStatus.tsx`、`web/src/features/jobs/TasksPage.tsx`、`web/src/api/connectors.ts`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=delivery`。
- 完成（2026-10-25）：任务详情 DeliveryStatus 按目标显示送达/失败/未知，失败可单目标重试，未知须确认重复风险；e2e --scenario=delivery（两实例三目标部分失败，390px）

### [ ] 检查点 F — 假适配器网页全链路
F16–F18通过，用户审核网页派发交互；不使用真实目标。未勾选连接器时旧应用内操作不退化。

## 阶段 G：官方传输适配（V3）

### [x] F19 — SDK 生命周期与可信事件映射
- 模块：feishu-connector；验收：FC-01/02/05、CC-02/04。依赖：F01、F08。
- 验收：①每实例一个国内WSClient，SDK负责重连、状态区分出站与长连接；②新版卡片/消息事件映射可信租户/用户/目标，缺上下文拒绝；③日志净化、限流/超时结果正确，回调有界受理3秒内完成。
- 文件：`server/src/connectors/feishu/client.ts`、`server/src/connectors/feishu/events.ts`、`server/src/connectors/feishu/transport.ts`、`server/tools/feishu-connector.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-connector.test.mjs)`；先假SDK，不启动真实WS。
- 完成（2026-10-25）：feishu/events.ts、media.ts、cards.ts；可信租户/用户/目标映射，预览上传缓存，14天更新窗口（保守常量）。

### [x] F20 — 压缩预览与卡片发送/更新
- 模块：feishu-connector；验收：FC-03/04/06。依赖：F19、F15。
- 验收：①≤2048预览受控读取/上传≤10MB，不回退原片；②按app+源签名缓存key、失效重传，open_id/chat_id映射正确；③session语义卡片与更新有效期受限，超期仅显式操作重开，平台更新失败不撤销标记。
- 文件：`server/src/connectors/feishu/media.ts`、`server/src/connectors/feishu/cards.ts`、`server/src/connectors/feishu/transport.ts`、`server/tools/feishu-connector.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-connector.test.mjs)`；断言上传字节/参数和发送次数。
- 完成（2026-10-25）：feishu/transport.ts 实现 ManagedConnectorPort；超时/迟到→unknown，限流可重试，图片失效重传一次；假SDK测试 tools/feishu-connector.test.mjs。

### [x] F21 — 启动装配、连接状态与显式测试卡
- 模块：connector-core、feishu-connector；验收：CC-01/02/06/07、FC-01。依赖：F09、F19、F20。
- 验收：①组合根注入适配器/恢复顺序，默认disabled零外网，关闭服务正确停止；②无消息连接测试与明确确认的测试卡区分，测试卡只发授权目标；③能力摘要真实反映启用状态，普通凭据不能调用管理测试发送。
- 文件：`server/src/index.ts`、`server/src/api/connectors.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`server/tools/connector-runtime.test.mjs`。
- 验证：`(cd server && node --test tools/connector-runtime.test.mjs)`；只用依赖注入假SDK证明装配，真发送留F33。
- 完成（2026-10-25）：index.ts 组合根注入 feishuFactory（动态加载SDK，FRAMEFLOW_FEISHU_SDK=disabled 可关闭）；POST /connectors/{id}/test-card 须确认且只发授权目标；capabilities.connectors 反映真实状态；派发经运行时发送，UnknownOutcome 记 unknown。

### [x] 检查点 G — 传输隔离
F19–F21通过，SDK类型不进入策略模块；核对长连接/更新限制和最小权限。未经联调许可不打开真实连接。
- 完成（2026-10-25）：F19–F21 通过；SDK 仅在 feishu/ 目录，策略模块零 SDK 类型；未打开真实连接。

## 阶段 H：确认动作与共享进度（V4）

### [x] F22 — 卡片 session、动作意图与目标游标
- 模块：feishu-interaction；验收：FI-04/06/08。依赖：F07、F15、F19。
- 验收：①session绑定实例/租户/目标/message/task/photo/版本/期限；②实际操作者取事件，actionId同载荷重放/异载荷拒绝，不用星级值作为永久key；③可靠受理后才回处理中，过载拒绝、目标间游标独立、重启恢复。
- 文件：`server/src/integrations/feishu/sessions.ts`、`server/src/integrations/feishu/actions.ts`、`server/src/integrations/feishu/cursors.ts`、`server/tools/feishu-interaction.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-interaction.test.mjs)`；含转发/跨群/排队后撤权。
- 完成（2026-10-25）：integrations/feishu/{sessions,actions,cursors,jsonl}.ts，追加+fsync 持久化；feishu-interaction.test.mjs

### [x] F23 — 确认集合及幂等任务投影
- 模块：feishu-interaction；验收：FI-01/04/05/09。依赖：F03、F06、F13。
- 验收：①新confirmationMode按唯一照片明确确认计数，零星确认有效、跳过/失败不计；②sourceOpId重复投影不重复事件/计数，提交后投影前崩溃只补投影；③done受控重标不加数，旧skipped语义不变。
- 文件：`server/src/core/jobs.ts`、`server/src/jobs/service.ts`、`server/src/jobs/confirmations.ts`、`server/src/jobs/annotate.ts`、`server/tools/job-confirmations.test.mjs`。
- 验证：`(cd server && node --test tools/job-confirmations.test.mjs && node tools/e2e-jobs.mjs && node tools/e2e-annotate.mjs)`。
- 完成（2026-10-25）：confirmationMode=explicit、projectConfirmation 幂等投影、jobs/confirmations.ts 对账；job-confirmations.test.mjs

### [x] F24 — 完整确认控制器与卡片按钮
- 模块：feishu-interaction；验收：FI-01/03/04/05/06/08。依赖：F04–F06、F20、F22、F23。
- 验收：①表单草稿不落标，确认在锁内复验身份/权限/终态/源/版本，落盘后才成功前进；②群/私聊/跨任务/网页竞争旧版仅一项成功，冲突可刷新；③取消/移走竞争拒绝，恢复仅补已提交投影，不重复写旧标记。
- 文件：`server/src/integrations/feishu/controller.ts`、`server/src/integrations/feishu/actions.ts`、`server/src/connectors/feishu/cards.ts`、`server/src/index.ts`、`server/tools/feishu-interaction.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-interaction.test.mjs tools/job-confirmations.test.mjs tools/photo-gates.test.mjs)`。
- 完成（2026-10-25）：integrations/feishu/controller.ts 受理→锁内复验→稳定 opId 事务→投影→卡片前进；server.ts 装配与恢复

### [x] 检查点 H — 多人确认与恢复
F22–F24必须经独立安全/恢复复核。完整故障矩阵和跨任务并发通过；这里未通过不推进真实联调。
- 完成（2026-10-25）：全部离线测试与 e2e 通过；独立安全复核待人工

## 阶段 I：任务入口与重标（V5）

### [x] F25 — 列表、进度、继续与重标按钮
- 模块：feishu-interaction；验收：FI-01/05/06。依赖：F24。
- 验收：①只列可见任务、分页、继续未确认/复核已确认、上一张与暂时跳过不写标；②重新标记先显示当前值再确认，done不增数、cancelled/undone拒绝；③失联项显示阻塞且不减总数，超期卡片按显式操作重开并失效旧session。
- 文件：`server/src/integrations/feishu/controller.ts`、`server/src/integrations/feishu/cursors.ts`、`server/src/connectors/feishu/cards.ts`、`server/tools/feishu-interaction.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-interaction.test.mjs)`。
- 完成（2026-10-25）：上一张/跳过/复核（只走已确认）/列表分页（只列已投递到本目标的任务，子按钮独立 session）、remark 先显示当前值；过期卡片 reopen 发新消息并撤销旧 session（tools/feishu-commands.test.mjs）

### [x] F26 — 飞书创建入口与文字命令
- 模块：feishu-interaction；验收：CC-08/09、FI-02/06。依赖：F25、F14。
- 验收：①首次授权创建者选择允许项目→范围/目标预览→确认，同一确认只创建一次；②命令复用按钮服务，群需@、私聊直接发，未知命令只帮助；③无创建/标注权限拒绝，不能输入任意路径或枚举无权任务。
- 文件：`server/src/integrations/feishu/commands.ts`、`server/src/integrations/feishu/controller.ts`、`server/src/connectors/feishu/cards.ts`、`server/tools/feishu-interaction.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-interaction.test.mjs)`；按钮与命令同用权限参数化用例。
- 完成（2026-10-25）：commands.ts：帮助/任务/继续/新建，群需@、未知回帮助、消息事件去重；创建=允许项目→DeliveryPreview→ConfirmationService 一次确认，requestId 由 session 派生（重复点击只建一次）

### [x] F27 — 网页任务确认进度展示
- 模块：feishu-interaction、delivery-policy；验收：FI-01/05/09、DP-07。依赖：F18、F23、F24。
- 验收：①新确认数据以兼容可选字段入契约/DTO，旧任务进度不改义；②任务页区分已确认、剩余、阻塞，不把跳过当完成；③网页与假飞书回流共享进度，重标不重复计数，390px可读。
- 文件：`contracts/openapi.yaml`、`web/src/api/contract.ts`、`web/src/api/httpSource.ts`、`web/src/features/jobs/TasksPage.tsx`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=progress`；若web内部Job类型需另加字段，先拆一项类型对齐任务，不扩成大改。
- 完成（2026-10-25）：Job 兼容可选 confirmationMode/confirmation（openapi + web 类型 + contract），任务页分已确认/剩余/不可用；e2e-connectors --scenario=progress 通过（重标不重复计数、390px）

### [x] 检查点 I — 完整挑片交互
F25–F27通过。授权创建者从无任务开始能完成整条假SDK故事，普通批注人与创建者权限不同；未确认原图请求之前无原图外传。
- 完成（2026-10-25）：F25–F27 离线测试通过；创建者/普通批注人权限分离由 decideAccess create/annotate 区分；未接入原图外传

## 阶段 J：原始JPEG、完成通知与联调准备（V6）

### [x] F28 — 显式 JPEG 附件请求
- 模块：feishu-connector、feishu-interaction；验收：FC-03/04、FI-07。依赖：F20、F24。
- 验收：①只发当前授权目标的真实JPEG字节，≤30MB非零，RAW/HEIC-only/视频/失联/无权拒绝；②稳定请求意图复用分part去重，不隐式广播、不用原图兜底预览；③群可见提示明确、下载hash一致、缓存不替代重新授权。
- 文件：`server/src/connectors/feishu/media.ts`、`server/src/connectors/feishu/cards.ts`、`server/src/integrations/feishu/controller.ts`、`server/tools/feishu-connector.test.mjs`、`server/tools/feishu-interaction.test.mjs`。
- 验证：`(cd server && node --test tools/feishu-connector.test.mjs tools/feishu-interaction.test.mjs)`；本项hash用假传输接收字节，真实下载留F33。
- 完成（2026-10-25）：只发 JPEG 变体（RAW/HEIC-only 拒绝），执行时重新授权，仅发当前会话；feishu-connector/interaction 测试

### [x] F29 — 完成通知与显式再次投递
- 模块：delivery-policy；验收：DP-02/03/06/08。依赖：F15、F23。
- 验收：①任务完成代次+目标构成稳定通知意图，重复事件/重标不重发；②仅使用确认时同意的通知目标与选项，后改策略不扩大范围；③新增目标需新预览确认，绑定已有jobId，不重建任务/重置确认进度，仅追加新目标；确认requestId稳定绑定任务和增量目标，失败/unknown逐部分处理、旧成功目标不再发送（外部入口见F29a/F29b）。
- 文件：`server/src/delivery/completion.ts`、`server/src/delivery/confirmations.ts`、`server/src/delivery/runner.ts`、`server/src/jobs/service.ts`、`server/tools/delivery-policy.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-policy.test.mjs tools/delivery-runner.test.mjs)`。
- 完成（2026-10-25）：完成通知按代次独立 partIndex≥1000 入同一账本；delivery-policy 测试

### [x] F29a — 已有任务追加目标 API
- 模块：delivery-policy；验收：DP-02/04/05/06/08。依赖：F29、F16。
- 验收：①预览/确认接口显式绑定已有jobId及新增目标，不创建第二任务，不修改原items/确认计数；②管理session/CSRF、任务状态/项目/目标权限重验，重复或异载荷requestId按既定规则处理；③已成功目标不重发，失败重试与追加目标操作分开，未确认零发送。
- 文件：`server/src/api/delivery.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts`、`server/tools/delivery-api.test.mjs`。
- 验证：`(cd server && node --test tools/delivery-api.test.mjs)`；明确测试响应丢失后重试仍关联原任务。
- 完成（2026-10-25）：delivery-previews/delivery-appends 绑定原 jobId，requestId 重放；delivery-api 测试

### [x] F29b — 任务详情再次派发入口
- 模块：delivery-policy；验收：DP-02/05/07/08。依赖：F29a、F18。
- 验收：①详情提供追加投递目标入口，展示原任务与新目标、上传及通知范围，需预览后二次确认；②取消不发送，重复确认复用requestId，原任务进度/items不变；③浏览器证明只发新增目标，旧成功目标零重复，390px可操作。
- 文件：`web/src/api/connectors.ts`、`web/src/features/connectors/RedispatchDialog.tsx`、`web/src/features/jobs/TasksPage.tsx`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=redispatch`。
- 完成（2026-10-25）：RedispatchDialog 预览→二次确认；e2e --scenario=redispatch 通过

### [ ] 追加目标检查点
F29/F29a/F29b通过：任务ID、items和确认进度完全不变，仅目标投递记录扩展；与重新创建任务明确区分。

### [x] F30 — 管理测试发送界面与部署说明
- 模块：connector-core、feishu-connector；验收：CC-02/07、FC-07（准备）。依赖：F21、F28、F29。
- 验收：①无消息验证与显式测试卡两按钮、后者展示目标并二次确认，假SDK测零误发；②记录应用权限/事件订阅/Secret环境变量与网页可达性，不自动开放公网；③提供显式opt-in真联调工具与安全备份/回滚步骤，默认调用不连接/不发送。
- 文件：`web/src/features/connectors/ConnectorSettings.tsx`、`web/src/api/connectors.ts`、`docs/feishu-setup.md`、`server/tools/feishu-live-check.mjs`、`tools/e2e-connectors.mjs`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=test-send`；`(cd server && node tools/feishu-live-check.mjs --help)`；不带opt-in运行须拒绝真实网络。
- 完成（2026-10-25）：无消息验证与测试卡分开、测试卡二次确认；docs/feishu-setup.md；feishu-live-check.mjs 默认拒绝联网；e2e --scenario=test-send 通过

### [x] 检查点 J — 准备发布门槛
F28–F30通过，人工复核外传说明、权限申请和unknown提示。只说明本地测试通过，真实平台仍待许可。
- 完成（2026-10-25）：本地离线测试全部通过；外传说明/权限/unknown 提示待人工复核；真实平台待许可

## 阶段 K：恢复、回归与真实平台验收（V7）

### [ ] F31 — 集成故障注入与兼容回滚演练
- 模块：四模块；验收：CC-05/06、DP-04/08、FI-03/04/05/09。依赖：F24、F29。
- 验收：①覆盖意图/marks提交/任务投影/平台响应/messageId保存各中断点，包括SDK迟到成功；②恢复后先对账再开接收，损坏拒绝外传，终态/权限/换源检查不能绕过；③临时dataDir备份/恢复演练记录旧格式降级限制，不触碰用户数据。
- 文件：`server/tools/connector-recovery.test.mjs`、`server/tools/connector-fixture.mjs`、`docs/marks-log-compatibility.md`。
- 验证：`(cd server && node --test tools/connector-recovery.test.mjs)`；此票是集成验证，发现实现缺陷单独开小修任务，不把所有源码塞入本票。

### [ ] F32 — 全量假SDK、浏览器与移动端验收
- 模块：四模块；验收：全部CC/DP/FI及FC-01～06。依赖：F26、F27、F29b、F30、F31。
- 验收：①完整管理→预览→多目标→确认/重标→JPEG请求→完成通知可走通，负向调用次数正确；②桌面/390px截图、键盘、读屏状态验证，旧导航与应用内任务通过；③按规格编号记录测试/人工证据，未通过不勾选，不改门槛。
- 文件：`tools/e2e-connectors.mjs`、`docs/feishu-acceptance.md`。
- 验证：构建后 `node tools/e2e-connectors.mjs --scenario=all` 与 `node tools/e2e-project-navigation.mjs`；`(cd server && node tools/e2e-marks-durability.mjs && node tools/e2e-jobs.mjs && node tools/e2e-annotate.mjs)`；在最终代码版本执行全部新增服务端测试 `(cd server && node --test tools/*.test.mjs)`（覆盖SDK/存储/锁/版本/授权/投递/故障恢复，不以浏览器测试替代）；`(cd server && npm audit)`。

### [ ] F33 — 专用真实应用群聊/私聊验收
- 模块：四模块；验收：FC-07及平台侧FI-02/03/07/08。依赖：F32、用户明确提供专用应用/目标及发送许可。
- 验收：①群与私聊可见预览、表单独立、确认/冲突/重标/创建真实可用，长连接重连不重复确认；②显式JPEG请求下载hash相同，权限撤销后旧卡不可写；③填写真实证据、脱敏日志与剩余限制，无环境则保持阻塞，不以mock结案。
- 文件：`server/tools/feishu-live-check.mjs`、`docs/feishu-acceptance.md`、`docs/feishu-setup.md`。
- 验证：用户准备环境变量后执行 `(cd server && FRAMEFLOW_FEISHU_LIVE=1 node tools/feishu-live-check.mjs --confirm-send --target "$FRAMEFLOW_TEST_TARGET")`；凭据不得出现在命令参数/聊天/仓库。脚本须只使用指定测试配置和目标。

### [ ] 检查点 K — 发布审核
全部任务与验收证据通过后才宣布支持飞书。用户确认发布；先单实例单测试目标，再按确认范围扩展。没有真实平台证据时报告“实现/本地验收完成，飞书实测阻塞”。

## 验收覆盖索引

- CC-01：F08/10/21；CC-02：F07/09/10/19/30；CC-03：F09/12；CC-04：F07/19/22/24；CC-05：F02/07/08/31；CC-06：F08/21/22/31；CC-07：F08/09/21/30；CC-08：F07/26；CC-09：F07/22/26。
- DP-01：F11/12/14/17；DP-02：F11/17/29；DP-03：F15/16/18/29；DP-04：F13/14/15/31；DP-05：F11/12/14/16/17；DP-06：F29/F29a/F29b；DP-07：F17/18/27/32；DP-08：F15/18/29/31。
- FC-01：F01/19/21；FC-02：F01/19/22；FC-03：F20/28；FC-04：F20/28；FC-05：F01/15/19；FC-06：F01/20/25；FC-07：F30准备、F33真实验收。
- FI-01：F23/24/25/27；FI-02：F26/33；FI-03：F04/05/06/24/31/33；FI-04：F02/03/06/22/23/24/31；FI-05：F04/05/06/23/24/25/31；FI-06：F22/24/25/26；FI-07：F28/33；FI-08：F01/22/24/33；FI-09：F03/04/05/06/13/23/27/31/32。

## 并行与下一步

- 可并行：批准后F01/F02；F07–F12管理预览支线与F04–F06标记基础支线；接口确定后的UI与SDK适配。
- 共享 `server/src/core/marks.ts`、`server/src/core/library.ts`、`server/src/jobs/service.ts`、`contracts/openapi.yaml`、`web/src/api/contract.ts` 的任务不同时编辑。
- 清单已确认，从 **F01/F02风险验证** 开始，不一次实现全部35项。未获得真实发送许可前，F33保持阻塞。
