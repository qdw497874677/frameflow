import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadLut } from './lutRenderer.ts';

test('LUT 上传：texImage3D 时 UNPACK_ALIGNMENT=1（33³ 一行 198 字节，不对齐会全黑）', () => {
  let align = 4;
  const seen: number[] = [];
  const gl = new Proxy({ UNPACK_ALIGNMENT: 0x0cf5 } as Record<string, unknown>, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (key === 'pixelStorei') return (_k: number, v: number) => { align = v; };
      if (key === 'texImage3D') return (...a: unknown[]) => { seen.push(align); assert.equal((a.at(-1) as Uint16Array).length, 33 ** 3 * 3); };
      if (key === 'createTexture') return () => ({});
      if (typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)) return 1;
      return () => {};
    },
  }) as unknown as WebGL2RenderingContext;
  uploadLut(gl, { size: 33, table: new Float32Array(33 ** 3 * 3) });
  assert.deepEqual(seen, [1]);
  assert.equal(align, 4, '用完恢复默认，不影响其它上传');
});
