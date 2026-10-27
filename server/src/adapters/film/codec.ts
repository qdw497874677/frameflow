/** FFE1 帧编解码（与 engine/src/protocol.cpp 对应）：`"FFE1" | u32 LE 头长 | JSON | u32 LE 载荷长 | 载荷` */
const MAGIC = Buffer.from('FFE1', 'ascii');
export const MAX_HEADER = 1 << 20;
export const MAX_PAYLOAD = 1 << 30;

export interface EngineFrame {
  readonly header: Record<string, unknown>;
  readonly payload: Buffer;
}

export class FrameError extends Error {}

export function encodeFrame(header: Record<string, unknown>, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + 4 + json.length + 4 + payload.length);
  MAGIC.copy(out, 0);
  out.writeUInt32LE(json.length, 4);
  json.copy(out, 8);
  out.writeUInt32LE(payload.length, 8 + json.length);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 12 + json.length);
  return out;
}

/** 流式解帧：push 进字节，取出完整帧；格式错直接抛（流已不可信，调用方应重启进程） */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): EngineFrame[] {
    this.chunks.push(chunk);
    this.length += chunk.length;
    const frames: EngineFrame[] = [];
    for (;;) {
      if (this.length < 8) break;
      const buf = this.flatten();
      if (!buf.subarray(0, 4).equals(MAGIC)) throw new FrameError('引擎输出不是 FFE1 帧');
      const hlen = buf.readUInt32LE(4);
      if (hlen > MAX_HEADER) throw new FrameError(`帧头过大：${hlen}`);
      if (buf.length < 12 + hlen) break;
      const plen = buf.readUInt32LE(8 + hlen);
      if (plen > MAX_PAYLOAD) throw new FrameError(`载荷过大：${plen}`);
      const total = 12 + hlen + plen;
      if (buf.length < total) break;
      let header: unknown;
      try { header = JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8')); } catch { throw new FrameError('帧头不是 JSON'); }
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new FrameError('帧头不是对象');
      frames.push({ header: header as Record<string, unknown>, payload: Buffer.from(buf.subarray(12 + hlen, total)) });
      const rest = buf.subarray(total);
      this.chunks = rest.length ? [rest] : [];
      this.length = rest.length;
    }
    return frames;
  }

  private flatten(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0]!;
  }
}
