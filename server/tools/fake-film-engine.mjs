#!/usr/bin/env node
// 测试用的假胶片引擎：讲 FFE1 帧协议，行为由 FAKE_FFE_MODE 决定（ok / hang-bake / crash-once / proto2）。
// 烘焙出来的 LUT = 单位 LUT 的反相，便于断言。
import fs from 'node:fs';

const mode = process.env.FAKE_FFE_MODE ?? 'ok';
const MAGIC = Buffer.from('FFE1');
let buf = Buffer.alloc(0);
let lastPayload = Buffer.alloc(0);
const payloadOf = () => lastPayload;

function send(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(8); MAGIC.copy(head); head.writeUInt32LE(json.length, 4);
  const plen = Buffer.alloc(4); plen.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([head, json, plen, payload]));
}

function handle(req) {
  const id = req.id ?? null;
  switch (req.op) {
    case 'hello': return send({ ok: true, id, engine: 'fake', version: 'fake-1', protocol: mode === 'proto2' ? 2 : 1, threads: 1 });
    case 'list_stocks': return send({ ok: true, id, stocks: [
      { id: 'portrait400', name: 'Portrait 400', inspiredBy: 'test', kind: 'negative' },
      { id: 'premierpaper', name: 'Premier Paper', inspiredBy: 'test', kind: 'paper' }] });
    case 'bake_lut': {
      if (mode === 'hang-bake') return undefined;
      const mark = process.env.FAKE_FFE_MARK;
      if (mode === 'crash-once' && mark && !fs.existsSync(mark)) { fs.writeFileSync(mark, '1'); process.exit(3); }
      if (req.stock !== 'portrait400') return send({ ok: false, id, error: { code: 'unknown_stock', message: `no stock ${req.stock}` } });
      const n = req.size;
      const out = Buffer.alloc(n ** 3 * 12);
      let i = 0;
      for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
        for (const v of [r, g, b]) { out.writeFloatLE(1 - v / (n - 1), i); i += 4; }
      }
      return send({ ok: true, id, size: n, format: 'f32' }, out);
    }
    case 'render': {
      // 假渲染：像素反相；打开颗粒时再 +1（便于断言参数传到了）
      if (mode === 'hang-render') return undefined;
      const n = req.width * req.height * 3;
      const src = payloadOf(req);
      if (src.length !== n) return send({ ok: false, id, error: { code: 'bad_request', message: 'payload size' } });
      const bump = req.params && req.params.grain > 0 ? 1 : 0;
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) out[i] = Math.min(255, 255 - src[i] + bump);
      return send({ ok: true, id, width: req.width, height: req.height, format: 'rgb8', ms: 1 }, out);
    }
    case 'shutdown': send({ ok: true, id }); return process.exit(0);
    default: return send({ ok: false, id, error: { code: 'unknown_op', message: req.op } });
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 8) return;
    const hlen = buf.readUInt32LE(4);
    if (buf.length < 12 + hlen) return;
    const plen = buf.readUInt32LE(8 + hlen);
    if (buf.length < 12 + hlen + plen) return;
    const req = JSON.parse(buf.subarray(8, 8 + hlen).toString());
    lastPayload = Buffer.from(buf.subarray(12 + hlen, 12 + hlen + plen));
    buf = buf.subarray(12 + hlen + plen);
    handle(req);
  }
});
process.stdin.on('end', () => process.exit(0));
