/**
 * 照片源版本（F04）：同一路径上的「同一个源文件」才共享标记状态。
 *
 * generation = 主文件（RAW/JPEG/视频）的路径+大小+mtime 指纹。重启后从扫描结果重算，结果稳定；
 * 同路径被替换（大小或 mtime 变化）→ 新 generation，旧标记只留审计，不继承。
 * 只用扫描已拿到的 stat，不额外读盘；写入前用 verifySourceGeneration 在锁内复核可达性。
 */
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileRef, PhotoRecord } from '../../../domain/photo.ts';

type Files = Pick<PhotoRecord, 'raw' | 'jpeg' | 'video'>;
const files = (rec: Files): FileRef[] => [rec.raw, rec.jpeg, rec.video].filter((f): f is NonNullable<typeof f> => !!f);

function fingerprint(parts: { path: string; size: number; mtimeMs: number }[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p.path}\u0000${p.size}\u0000${Math.trunc(p.mtimeMs)}\n`);
  return 'g1-' + h.digest('hex').slice(0, 32);
}

export function sourceGeneration(rec: Files): string | null {
  const fs = files(rec);
  return fs.length ? fingerprint(fs) : null;
}

/**
 * 现在重新 stat 一次：不可达（挂载失联/超时/文件消失）→ null；可达返回当下 generation。
 * 调用方比较它与记录中的 generation：不同即源已更换，需要重扫，不能确认。
 */
export async function verifySourceGeneration(rec: Files, timeoutMs = 3000): Promise<string | null> {
  const list = files(rec);
  if (!list.length) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  try {
    const probed = Promise.all(list.map(async f => { const s = await stat(f.path); return { path: f.path, size: s.size, mtimeMs: s.mtimeMs }; }))
      .then(fingerprint, () => null);
    return await Promise.race([probed, timeout]);
  } finally { clearTimeout(timer); }
}
