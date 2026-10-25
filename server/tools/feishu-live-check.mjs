#!/usr/bin/env node
/**
 * 飞书真实联调工具（F30，为 F33 准备）。**默认不连接、不发送。**
 *
 *   node tools/feishu-live-check.mjs --help
 *   FEISHU_LIVE_APP_ID=cli_xxx FEISHU_LIVE_SECRET_ENV=MY_SECRET_VAR MY_SECRET_VAR=... \
 *     node tools/feishu-live-check.mjs --live --i-understand-network            # 仅无消息验证（取 tenant_access_token）
 *   ...同上 --send-test-card --chat-id=oc_xxx --i-understand-sending            # 额外向一个专用测试群发送一张测试卡
 *
 * 规则：没有 --live 与 --i-understand-network 时拒绝任何网络访问（退出码 2）；
 * 发送还须 --send-test-card、--chat-id 与 --i-understand-sending 三者齐备。Secret 只从环境变量读取，绝不打印。
 */
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (k) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);

const HELP = `feishu-live-check —— 飞书真实联调（显式 opt-in）

默认行为：打印本说明并退出，不连接网络、不发送消息。

选项：
  --help                      显示本说明
  --live --i-understand-network
                              允许连接飞书开放平台，只做无消息验证（tenant_access_token）
  --send-test-card --chat-id=oc_xxx --i-understand-sending
                              额外向该专用测试群发送一张测试卡（需上面的联网 opt-in）

环境变量：
  FEISHU_LIVE_APP_ID          专用测试应用的 App ID（cli_…）
  FEISHU_LIVE_SECRET_ENV      存放 App Secret 的环境变量名（工具只读该变量，不打印）

退出码：0 成功；1 平台返回失败；2 未 opt-in / 参数缺失（未联网）。
部署与回滚步骤见 docs/feishu-setup.md。`;

function refuse(msg) {
  console.error(`拒绝：${msg}（未发起任何网络请求）`);
  process.exit(2);
}

async function main() {
  if (has('--help') || args.length === 0) { console.log(HELP); if (args.length === 0) process.exitCode = 2; return; }
  if (!has('--live') || !has('--i-understand-network')) refuse('需要 --live 与 --i-understand-network 才会联网');
  const appId = process.env.FEISHU_LIVE_APP_ID;
  const secretEnv = process.env.FEISHU_LIVE_SECRET_ENV;
  if (!appId || !/^cli_[A-Za-z0-9]+$/.test(appId)) refuse('FEISHU_LIVE_APP_ID 缺失或格式不对');
  if (!secretEnv || !process.env[secretEnv]) refuse('FEISHU_LIVE_SECRET_ENV 未指向已设置的环境变量');
  const wantSend = has('--send-test-card');
  const chatId = val('--chat-id');
  if (wantSend && (!chatId || !/^oc_[A-Za-z0-9]+$/.test(chatId) || !has('--i-understand-sending'))) refuse('发送测试卡需要 --chat-id=oc_… 与 --i-understand-sending');

  const { loadRealSdk } = await import('../src/adapters/feishu/client.ts');
  const sdk = await loadRealSdk();
  const api = sdk.api(appId, process.env[secretEnv]);
  const v = await api.verifyToken();
  if (v.code !== 0) { console.error(`无消息验证失败：FEISHU_${v.code ?? 'UNKNOWN'}`); process.exit(1); }
  console.log('ok 无消息验证通过（未发送消息）');
  if (!wantSend) return;
  const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'FrameFlow 测试卡' } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '这是一张联调测试卡，不含照片或任务信息。' } }] };
  const r = await api.createMessage({ receiveIdType: 'chat_id', receiveId: chatId, msgType: 'interactive', content: JSON.stringify(card), uuid: `live_${Date.now().toString(36)}` });
  if (r.code !== 0) { console.error(`测试卡发送失败：FEISHU_${r.code ?? 'UNKNOWN'}`); process.exit(1); }
  console.log(`ok 测试卡已发送 message_id=${r.data?.message_id ?? '?'}`);
}

main().catch((e) => { console.error(`失败：${e instanceof Error ? e.name : 'Error'}`); process.exit(1); });
