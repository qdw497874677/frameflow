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
  /** 已知下一帧总长时，不够就不拼（整帧渲染的载荷几十 MB，逐块拼接是平方级拷贝） */
  private need = 0;

  push(chunk: Buffer): EngineFrame[] {
    this.chunks.push(chunk);
    this.length += chunk.length;
    const frames: EngineFrame[] = [];
    for (;;) {
      if (this.length < 8 || this.length < this.need) break;
      const buf = this.flatten();
      if (!buf.subarray(0, 4).equals(MAGIC)) throw new FrameError('引擎输出不是 FFE1 帧');
      const hlen = buf.readUInt32LE(4);
      if (hlen > MAX_HEADER) throw new FrameError(`帧头过大：${hlen}`);
      if (buf.length < 12 + hlen) { this.need = 12 + hlen; break; }
      const plen = buf.readUInt32LE(8 + hlen);
      if (plen > MAX_PAYLOAD) throw new FrameError(`载荷过大：${plen}`);
      const total = 12 + hlen + plen;
      if (buf.length < total) { this.need = total; break; }
      this.need = 0;
      let header: unknown;
      try { header = JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8')); } catch { throw new FrameError('帧头不是 JSON'); }
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new FrameError('帧头不是对象');
      frames.push({ header: header as Record<string, unknown>, payload: rest0(buf, 12 + hlen, total) });
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

/** 载荷：帧正好占满缓冲时直接切片（省一次几十 MB 的拷贝），否则复制出来 */
function rest0(buf: Buffer, start: number, end: number): Buffer {
  return end === buf.length ? buf.subarray(start, end) : Buffer.from(buf.subarray(start, end));
}
