// F01 only: synthetic fixtures, no credentials, sockets, or platform acceptance claims.
import assert from 'node:assert/strict';
import { test, before, after, mock } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
let sdk;
let networkAttempts = 0;
const blocked = () => { networkAttempts++; throw new Error('F01 forbids network'); };
const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(k => [k, () => {}]));
const credentials = { appId: 'offline-app', appSecret: 'not-a-real-secret', logger };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const message = { params: { receive_id_type: 'chat_id' }, data: {
  receive_id: 'offline-chat', msg_type: 'interactive', content: '{"elements":[]}', uuid: 'offline-intent-1',
} };
const success = { code: 0, data: { message_id: 'offline-message' } };
const client = httpInstance => new sdk.Client({ ...credentials, domain: sdk.Domain.Feishu,
  disableTokenCache: true, ...(httpInstance ? { httpInstance } : {}) });

before(async () => {
  // Guard BEFORE importing the SDK, including ws/axios and fetch escape routes.
  for (const module of [http, https]) for (const key of ['request', 'get']) mock.method(module, key, blocked);
  mock.method(net.Socket.prototype, 'connect', blocked);
  mock.method(tls, 'connect', blocked);
  mock.method(dns, 'lookup', blocked);
  mock.method(dns.promises, 'lookup', blocked);
  mock.method(globalThis, 'fetch', blocked);
  syncBuiltinESMExports();
  sdk = await import('@larksuiteoapi/node-sdk');
});
after(() => {
  const attempts = networkAttempts;
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(attempts, 0, 'no test may attempt network, even if its error is caught');
});

test('exact audited version and documented defaults / type limitations', () => {
  const entry = require.resolve('@larksuiteoapi/node-sdk');
  const root = new URL('../', `file://${entry}`);
  assert.equal(JSON.parse(readFileSync(new URL('package.json', root))).version, '1.76.0');
  assert.equal(sdk.Domain[sdk.Domain.Feishu], 'Feishu');
  assert.equal(sdk.defaultHttpInstance.defaults.timeout, 0);
  const types = readFileSync(new URL('types/index.d.ts', root), 'utf8');
  assert.match(types, /declare class WSClient/);
  assert.match(types, /eventDispatcher: EventDispatcher/);
  // Generic registration accepts callbacks, but there is no generated form-value schema.
  assert.match(types, /register<T = \{\}>\(handles: IHandles & T\): this/);
  assert.equal(types.includes('form_value'), false);
});

test('generated message create / card patch preserve domestic URL, content, uuid and result', async () => {
  const calls = [];
  const c = client({ request: async opts => { calls.push(opts); return success; } });
  assert.deepEqual(await c.im.message.create(message), success);
  const content = JSON.stringify({ elements: [{ tag: 'markdown', content: '处理中' }] });
  assert.deepEqual(await c.im.message.patch({ path: { message_id: 'offline-message' }, data: { content } }), success);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/im/v1/messages');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].data, message.data);
  assert.deepEqual(calls[0].params, message.params);
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages/offline-message');
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].data, { content });
});

test('WS discovery uses domestic endpoint and 15s timeout; fatal fake response opens no socket', async () => {
  const calls = [];
  const failed = deferred();
  const appId = 'cli_0000000000000000'; // shape-valid synthetic identifier
  const ws = new sdk.WSClient({ ...credentials, appId, autoReconnect: false, onError: failed.resolve,
    httpInstance: { request: async opts => { calls.push(opts); return { code: 1, msg: 'offline refusal', data: {} }; } },
  });
  try {
    await ws.start({ eventDispatcher: new sdk.EventDispatcher({ logger }) });
    // start() launches but does not await reConnect(); wait for lifecycle evidence.
    const error = await failed.promise;
    assert.match(error.message, /pullConnectConfig failed/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://open.feishu.cn/callback/ws/endpoint');
    assert.equal(calls[0].timeout, 15000);
    assert.deepEqual(calls[0].data, { AppID: appId, AppSecret: credentials.appSecret });
  } finally { ws.close({ force: true }); }
});

test('synthetic WS event -> EventDispatcher -> form values + toast/card acknowledgement', async () => {
  const envelope = { schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'offline-event',
    app_id: 'offline-app', tenant_key: 'offline-tenant' }, event: {
    operator: { open_id: 'offline-actor', tenant_key: 'offline-tenant' }, token: 'offline-action-token',
    context: { open_message_id: 'offline-message', open_chat_id: 'offline-chat' },
    action: { tag: 'button', value: { session: 'opaque-session', action: 'confirm' },
      form_value: { rating: '3', trash: ['yes'] } },
  } };
  let received;
  const reply = { toast: { type: 'info', content: '处理中' }, card: { type: 'raw', data: { elements: [] } } };
  const dispatcher = new sdk.EventDispatcher({ logger }).register({
    'card.action.trigger': async event => { received = event; return reply; },
  });
  const ws = new sdk.WSClient({ ...credentials, autoReconnect: false,
    httpInstance: { request: blocked } });
  // Version-specific private seam: exercise actual frame handling without start/connect.
  ws.eventDispatcher = dispatcher;
  const frames = [];
  ws.sendMessage = frame => frames.push(frame);
  try {
    await ws.handleEventData({ headers: Object.entries({ type: 'event', message_id: 'frame-1', sum: '1', seq: '0', trace_id: 'offline' })
      .map(([key, value]) => ({ key, value })), payload: Buffer.from(JSON.stringify(envelope)) });
    assert.deepEqual(received.action, envelope.event.action);
    assert.deepEqual(received.operator, envelope.event.operator);
    assert.deepEqual(received.context, envelope.event.context);
    assert.equal(received.tenant_key, 'offline-tenant');
    assert.equal(received.app_id, 'offline-app');
    assert.equal(received.event_id, 'offline-event');
    assert.equal(frames.length, 1);
    const ack = JSON.parse(Buffer.from(frames[0].payload).toString());
    assert.equal(ack.code, 200);
    assert.deepEqual(JSON.parse(Buffer.from(ack.data, 'base64').toString()), reply);
  } finally { ws.close({ force: true }); }
});

test('generated HTTP methods do not forward timeout/signal options or retry transport failures', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ERR_CANCELED']) {
    const calls = [];
    const error = Object.assign(new Error('synthetic transport failure'), { code });
    const c = client({ request: async opts => { calls.push(opts); throw error; } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(c.im.message.create(message, { timeout: 1, signal: controller.signal }), e => e === error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeout, undefined);
    assert.equal(calls[0].signal, undefined);
  }
  let calls = 0;
  const c = client({ request: async () => { calls++; return { code: 99991400, msg: 'synthetic rate limit' }; } });
  assert.equal((await c.im.message.create(message)).code, 99991400);
  assert.equal(calls, 1);
});

test('default Axios stack propagates fake adapter timeout once; timeout remains transport responsibility', async () => {
  const defaults = sdk.defaultHttpInstance.defaults;
  const previous = defaults.adapter;
  let calls = 0;
  defaults.adapter = async config => {
    calls++;
    assert.equal(config.timeout, 0);
    throw Object.assign(new Error('synthetic adapter timeout'), { code: 'ECONNABORTED' });
  };
  try {
    await assert.rejects(client().im.message.create(message), { code: 'ECONNABORTED' });
    assert.equal(calls, 1);
  } finally { defaults.adapter = previous; }
});

test('Axios cancellation can reject locally AFTER fake remote accepted; not proof of unsent', async () => {
  const defaults = sdk.defaultHttpInstance.defaults;
  const previous = { adapter: defaults.adapter, signal: defaults.signal };
  const controller = new AbortController();
  const entered = deferred();
  const remote = deferred();
  let calls = 0;
  defaults.signal = controller.signal;
  defaults.adapter = async config => {
    calls++;
    entered.resolve();
    await remote.promise;
    return { status: 200, statusText: 'OK', headers: {}, config, data: success };
  };
  try {
    const attempt = client().im.message.create(message);
    const rejected = assert.rejects(attempt, { code: 'ERR_CANCELED' });
    await entered.promise;
    controller.abort();
    remote.resolve(success); // remote effect is deliberately not undone by local abort
    await rejected;
    assert.equal(calls, 1);
  } finally {
    defaults.adapter = previous.adapter;
    if (previous.signal === undefined) delete defaults.signal;
    else defaults.signal = previous.signal;
  }
});

test('self-built app token acquisition caches success and never sends after authentication failure', async () => {
  const cached = new Map();
  const calls = [];
  const c = new sdk.Client({ ...credentials, appId: 'offline-auth-probe', domain: sdk.Domain.Feishu,
    appType: sdk.AppType.SelfBuild,
    cache: { get: key => cached.get(key), set: (key, value) => cached.set(key, value) },
    httpInstance: {
      post: async (url, body) => {
        calls.push({ url, body });
        return { code: 0, tenant_access_token: 'offline-tenant-token', expire: 7200 };
      },
      request: async opts => { calls.push(opts); return success; },
    },
  });
  await c.im.message.create(message);
  await c.im.message.create(message);
  assert.equal(calls.length, 3, 'one token acquisition then two explicit sends');
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.deepEqual(calls[0].body, { app_id: 'offline-auth-probe', app_secret: credentials.appSecret });
  assert.equal(calls[1].headers.Authorization, 'Bearer offline-tenant-token');
  assert.equal(calls[2].headers.Authorization, 'Bearer offline-tenant-token');

  for (const response of [new Error('offline authentication timeout'), { code: 10003, msg: 'offline invalid credentials' }]) {
    let attempts = 0;
    const rejected = new sdk.Client({ ...credentials, appId: 'offline-auth-failure',
      appType: sdk.AppType.SelfBuild, cache: { get: () => undefined, set: () => assert.fail('bad token cached') },
      httpInstance: {
        post: async () => { attempts++; if (response instanceof Error) throw response; return response; },
        request: async () => assert.fail('must not send after token failure'),
      },
    });
    await assert.rejects(rejected.im.message.create(message));
    assert.equal(attempts, 1, 'no internal retry in tested token branch');
  }
});

test('application deadline leaves original send alive; late success belongs to original attempt', async () => {
  const entered = deferred();
  const remote = deferred();
  const deadline = deferred();
  let calls = 0;
  const c = client({ request: async () => { calls++; entered.resolve(); return remote.promise; } });
  const attempt = c.im.message.create(message);
  await entered.promise;
  const observed = Promise.race([attempt, deadline.promise]);
  deadline.resolve('unknown'); // deterministic application timer boundary, not a transport timeout
  assert.equal(await observed, 'unknown');
  assert.equal(calls, 1);
  remote.resolve(success);
  assert.deepEqual(await attempt, success);
  assert.equal(calls, 1, 'no replacement send');
});
