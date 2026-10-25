# F01 — 飞书官方 SDK 离线验证

验证日期：2026-10-23（主线以本机 `date -I` 复核）。范围仅 F01；没有实现连接器、修改任务状态或连接真实飞书。结果是**本地 SDK 路径可用，官方专门的回调文档明确支持新版卡片长连接；真实平台验收仍未执行**。F33 必须取得授权并进行真实验证。主线追加查证解决了README笼统限制与源码的矛盾，见下文。

## 版本与来源

- Node `26.8.2` / npm `11.19.1`；独立安装边界 `server/package-lock.json`（没有根 workspace lock）。
- `npm view @larksuiteoapi/node-sdk dist-tags --json` 返回 latest `1.76.0`（alpha `1.51.0-alpha.0`、beta `1.57.0-beta.1`）。选用并精确锁定 **1.76.0**，未使用浮动范围；锁文件固定传递依赖。
- npm 官方 registry 元数据：<https://registry.npmjs.org/@larksuiteoapi%2fnode-sdk/1.76.0>；repository 指向 <https://github.com/larksuite/node-sdk>。
- 实际审核发布物：<https://registry.npmjs.org/@larksuiteoapi/node-sdk/-/node-sdk-1.76.0.tgz>。SHA-512 integrity 为 `sha512-v/bxQNCugwAmMPbZtBGJtSu8hdQLiB1/29Jr+GBIG18DyQ4LYyp7gxQ74pkhXVSuoUeH4v+/ZHAw/SW+KMrj2g==`。
- 最新官方 README 已读取：<https://raw.githubusercontent.com/larksuite/node-sdk/main/README.md>；另核对发布包的 README、`lib/index.js`、`types/index.d.ts`。main 会变化，离线断言以安装的精确版本为准。
- README Client 参数明确国内域名 `https://open.feishu.cn`、默认 `Domain.Feishu`、可注入 `httpInstance`，默认 `axios.create()`；长连接说明要求 **3 秒内处理**。
- 平台参考：<https://open.feishu.cn/document/feishu-cards/card-callback-communication>、<https://open.feishu.cn/document/ukTMukTMukTM/uYzM3QjL2MzN04iNzcDN/configuring-card-callbacks/card-callback-structure>、<https://open.feishu.cn/document/server-docs/im-v1/message-card/patch>。搜索到官方索引的 `form_value` 说明，但完整页面抓取遇到动态渲染/证书错误；未绕过 TLS，不把搜索摘要当完整验收证据。消息 patch 的官方 API Explorer 链接也直接包含在发布包代码内：<https://open.feishu.cn/api-explorer?project=im&resource=message&apiName=patch&version=v1>。

## 离线探针与证据边界

运行：

```sh
(cd server && node --test tools/feishu-sdk-probe.test.mjs)
(cd server && npm run typecheck)
(cd server && npm audit)
(cd server && npm audit signatures)
git diff --check
```

探针不读取环境密钥、配置、照片或数据目录。所有 app/token/chat/message 值均为合成占位符。SDK 导入前封锁 HTTP(S)、Socket.connect、TLS、DNS lookup 和 fetch；最后断言网络调用次数为零，即 SDK 吞掉网络错误也会失败。SDK 请求走假 `httpInstance` 或默认 Axios 的假 adapter。没有监听本地端口，没有实际 WS 握手。全局 mock 和 Axios defaults 会恢复；测试必须串行运行，不给同一进程增加并发测试。

| 测试 | 证明了什么 | 没有证明什么 |
|---|---|---|
| exact audited version / defaults / types | SDK 精确版本、Feishu 枚举、默认 Axios timeout=0、WSClient/EventDispatcher 类型存在；泛型注册允许自定义回调 | 未生成 `form_value` 类型，不是完整表单 schema 保证 |
| generated create / patch | 国内 POST `/open-apis/im/v1/messages`、PATCH `/open-apis/im/v1/messages/:message_id`；content、receive_id、uuid 和 message_id 结果映射 | 真实卡片 JSON 合法性、共享更新效果、uuid 平台去重 |
| WS discovery | 默认国内 `/callback/ws/endpoint`，发现请求 timeout=15000；假失败只调用一次，不开 socket | 真握手、认证、心跳与断网重连 |
| synthetic WS event | 直接调用版本绑定的私有 `handleEventData`，经过真实 EventDispatcher；保留 operator、tenant/app/event ID、context、action.value、action.form_value；toast/raw card 返回序列化进 base64 ack | 平台是否发送该 envelope、字段可信性、完整表单值、客户端 toast/card 显示 |
| generated HTTP failures | ETIMEDOUT/ECONNRESET/ERR_CANCELED 各一次 request 后抛原错误；业务 rate-limit code 原样返回且只调用一次；传给生成方法的 timeout/signal 被忽略 | 所有 API/认证分支无重试；真实 429、token 轮换行为 |
| default Axios fake adapter timeout | 默认 Axios 响应链传播合成 ECONNABORTED，一次 adapter 调用，timeout=0 | 真实 socket timeout、DNS/连接/上传时限 |
| cancellation after acceptance | adapter 已进入、假远端已接受后，Axios 可因本地 AbortSignal 返回 ERR_CANCELED | 远端撤回或未发送，或生成方法支持 per-call signal |
| self-built app token acquisition | 默认启用缓存的自建应用路径：一次token获取后两次显式发送、Authorization注入；token传输失败/缺token返回均仅调用一次并拒绝发送、不缓存失败值 | 未证明所有认证模式、真实过期并发刷新/平台限流行为 |
| application deadline / late success | 应用 Promise.race 超时不会终止原 SDK Promise，原 attempt 之后仍拿到 message_id，调用数仍为 1 | 任何生产持久化/unknown 状态机已经实现 |

这里测试的是所选择的低层 `Client` / `WSClient` / `EventDispatcher`，**不使用新高层 Channel**（它有自己的 retry 路径）。取消测试在隔离进程中用 Axios defaults 注入 signal，是验证传输语义的测试缝，不是建议生产修改共享 singleton。应用计时边界使用可控制 Promise，无依赖机器快慢的睡眠断言。timeout 测试抛的是合成 transport 错误，不假称测量了真实网络时限。

### 源码定位（发布包 1.76.0）

- `server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:185-204`：默认 Axios 实例和 response interceptor，无默认 timeout/通用重试。
- `server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:65678-65692`：message.patch 仅转发 data/params/headers，catch 记录再抛；message.create 同一生成模式。
- `server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:100862-100890`：v2 header/event 合并；`server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:101072-101094`：dispatcher invoke。
- `server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:102552-102605`：WS discovery；`server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:102919-102963`：事件 frame→dispatcher→ack。
- `server/node_modules/@larksuiteoapi/node-sdk/lib/index.js:103037-103067`：start 校验 cli_ + 16 hex ID，启动但不 await reConnect；不能把 await start 当 ready。
- `server/node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:57-89`：request options/HttpRequestOptions；后者有 timeout，但无 signal；generated methods 的 options 不是任意 Axios 配置。

初次运行 6/8 通过：错误假设 Domain.Feishu 是字符串、WS 假 ID 未满足 SDK 格式导致未发 discovery。依据上述源码修正为枚举断言和形状合法的零 ID，并等待 onError 生命周期证据，未删除断言。初版第二次及该版最终离线运行 8/8 通过（后续补证版为9/9）。该任务是允许的依赖探针，不声称做了业务实现的红绿循环。

## 依赖审计

安装命令：`npm install --save-exact --ignore-scripts @larksuiteoapi/node-sdk@1.76.0`。未运行 audit fix。现存包版本没有变化，新增 50 个 lock 条目；部分已有依赖从 dev-only 变为生产可达。关键解析版本：axios `1.20.0`、ws `8.22.0`、protobufjs `7.6.6`、qs `6.16.1`、lodash.merge `4.6.2`。新增 protobufjs 有 postinstall：审核 `scripts/postinstall.js` 仅检查依赖版本方案并打印警告，本次仍不执行；SDK 没有 install lifecycle。

| | 安装前 | 安装后 |
|---|---:|---:|
| critical / high / moderate | 0 / 0 / 0 | 0 / 0 / 0 |
| low | 1 | 1 |
| npm audit exit | 1 | 1 |
| audit metadata dependency total | 134 | 184 |

唯一现存风险：Fastify `5.12.5`，<https://github.com/advisories/GHSA-389g-gv7q-r4x8>，header validation 的 case-sensitive propertyNames bypass，low；影响范围 `>=5.12.2 <5.12.6`，修复版本 `5.12.6`。Fastify 是运行时依赖，具体 header schema 可达性本任务未完成审查；不能称无风险。F01 不扩大到升级现有 Fastify，需主线在下一发布前评估修复并回归（最迟复核日期 2026-10-30，若提前发布则以发布日为准）。新增 SDK 及传递依赖未引入已知 audit finding，不代表没有未知漏洞。

`npm audit signatures`：138 packages verified registry signatures，20 verified attestations，exit 0。签名验证不能证明功能正确或所有包都有 provenance。供应链安装/取证使用 npm/文档网络；**离线保证适用于探针执行，不是 npm 下载过程**。

## 必须保留的阻塞与实现约束

1. **官方文档矛盾已进一步查证**：发布包英文README长连接段仍写 “only supports event subscriptions and does not support callback subscriptions”。主线2026-10-23完整读取官方 [Node SDK Handle callbacks](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks)：明确推荐 persistent connection，并给出 `WSClient` + `EventDispatcher.register({'card.action.trigger': ...})` 代码；限制仅指 **message card callback interaction (old)** 不支持长连接。新版自建应用方向有官方直接依据，不需要退回Webhook。文档还说明3秒响应、单应用最多50连接、集群随机单客户端收取、action.value只能为对象。真实FC-02/FI-08仍需F33实测，不能用文档和合成frame替代。
2. 新卡片表单事件没有生成专用类型；未来适配器必须做严格运行时校验，不把 generic register 接受任意字段当可信 schema。SDK v2 parse 合并 header 和 event，亦不能把任意传入事件当可信来源。F33 核实 operator、tenant、chat、message 字段及转发/群/私聊差异。
3. 生成 IM 方法无 per-call timeout/signal 转发，默认 HTTP timeout=0。后续需要经过审查的实例级有界 HTTP 配置；单纯 Promise.race 不取消发送。超时/取消后保持 unknown 与原 attempt 关联，禁止替代并发发送，迟到成功归并并持久化 message_id；重启不推断远端未发。F01 没有实现该状态机。
4. SDK 自带 logger 会看到错误/部分事件；生产必须注入净化 logger，不能输出认证头、secret 或完整事件。探针使用静默 logger，不宣称已完成生产脱敏。
5. 本轮 server typecheck 首次失败：并行新增 `server/src/connectors/writer.ts:4-5` 引用尚不存在的 `./journal.ts`，TS2307；不属于 F01 owned files，未改动。最终结果见下方复核记录。

## 最终复核记录

- `node --test tools/feishu-sdk-probe.test.mjs`：复核后增加自建应用token获取场景，最终9/9通过，无跳过，无网络尝试（最初worker版本为8项）。
- `npm run typecheck`：最终 exit 0；上文临时缺失 journal 的并行工作状态已消失，本任务未改其文件。
- `npm audit`：exit 1，仅既存 Fastify low；没有新增 finding。
- `npm audit signatures`：exit 0，138 个签名通过、20 个 attestations 通过。
- 在独立临时目录复制 manifest/lock/probe，执行 `npm ci --ignore-scripts` 后重跑探针：安装 exit 0、初版探针8/8通过，证明锁文件可重现且不需要执行安装脚本。未清理/替换工作仓库 node_modules。
- `git diff --check`：exit 0。仅修改 F01 指定四个文件；未提交、未调整 tasks/spec。自查没有生产连接、日志数据或重试状态机代码，README与新版回调文档的差异已由主线补查；保留真实平台能力作为F33验收门槛。

## 主线复核补证（2026-10-23）

- 官方Node SDK回调专页原文："The long connection mode only supports enterprise self-built applications."；"The message card callback interaction (old) callback does not support the Receive callbacks through persistent connection subscription method"。同页推荐方式一的代码为 `new Lark.WSClient(...)`、`new Lark.EventDispatcher({}).register({'card.action.trigger': ...})`、`wsClient.start({eventDispatcher})`。据此采用新版卡片，不把旧回调限制扩大成所有回调禁止。来源：<https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks>（本机日期2026-10-23完整读取）。
- 独立评审指出初版探针全部绕过token缓存；现增加默认自建应用认证路径，用假 `.post` 和 `.request` 验证成功缓存、Bearer头、两种失败零消息发送。范围仍是所测分支，不外推所有SDK认证模式无重试。
- 主线重新执行 `npm audit --json`：仍仅1项既存Fastify low；运行时尚未接入SDK，无真实连接和消息。

## F33 真实验证清单（待授权，不执行）

- 国内自建专用测试应用、机器人能力、一个受控群和私聊；仅开启发送机器人消息所需权限（候选 `im:message:send_as_bot`）、必要接收事件及 `card.action.trigger` 回调；媒体/JPEG 若进入对应阶段才申请资源上传权限。准确 scope 清单需开发者后台按实际 API 确认，不能用广泛通讯录、云盘或管理员权限代替。
- 长连接接收新版 card.action.trigger；手机/桌面完整星级与待删表单、unchecked/空值、不同用户同时提交、可信身份与目标字段、3 秒内可靠受理 toast、后续共享卡片 patch、过期及转发拒绝。
- 实测更新的发送者一致性、共享卡片设置、群/私聊可见性、平台频控/时间限制、重复 callback 与重连；记录脱敏证据，不转储完整事件。
- 真实超时/取消与迟到成功、远端核对、uuid 去重期限；原图下载 hash、权限撤回与零外传停用留在相应任务/F33，不能由本文件标成通过。
