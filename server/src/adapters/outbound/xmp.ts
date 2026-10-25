/**
 * 照片旁的 XMP sidecar（读 + 写）。
 *
 * 为什么落照片旁：标注要能在别处被看见（Lightroom / Capture One / Bridge），
 * 应用坏了、删了、换机器了，用户的整理成果还在（ADR 0003 / 票 001）。
 *
 * 编码 —— 只用**一个**通用字段 `xmp:Rating`：
 *   - 星级 1–5  → `xmp:Rating = 1..5`
 *   - 待删      → `xmp:Rating = -1`   ← 这正是 Lightroom / Bridge 的「rejected」标记
 *   - 无标注    → `xmp:Rating = 0`
 * 为什么不自造 `artworks:del`：自造字段只有我们自己认识，而 -1 是现成的行业等价物，
 * 且天然满足「星与待删互斥」。读的时候仍然认老字段 `artworks:del`（兼容早期版本写的文件）。
 *
 * 读写都用字符串操作，不引 XML 解析器：只要一个整数，不值得被 XMP 的命名空间花样绊倒。
 * 写入是**外科手术式**的：只改/插 `xmp:Rating`，Lightroom 写在同一个 sidecar 里的
 * 显影参数（`crs:*`）与历史一概不动。落盘用 同目录 tmp + rename（网络共享上也是原子的）。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

const RATING_ATTR = /\bxmp:Rating\s*=\s*"(-1|[0-5])"/;
const RATING_EL = /<xmp:Rating>\s*(-1|[0-5])\s*<\/xmp:Rating>/;
const DEL_ATTR = /\bartworks:del\s*=\s*"(true|false|1|0)"/;
const DEL_EL = /<artworks:del>\s*(true|false|1|0)\s*<\/artworks:del>/;

export interface XmpMarks {
  stars?: number;
  del?: boolean;
}

/** `{stars, del}` ↔ XMP 里那一个整数 */
export function ratingOf(marks: { stars: number; del: boolean }): number {
  if (marks.del) return -1;
  return Math.max(0, Math.min(5, Math.trunc(marks.stars)));
}

/**
 * 读 sidecar。**全异步**：照片目录可能在网络挂载上，同步 FS 一旦撞上挂死的挂载
 * 会把整个进程（事件循环）冻住 —— 票 011 的事故就是这么来的。
 */
export async function readXmpMarks(sidecarPath: string): Promise<XmpMarks | null> {
  let xml: string;
  try {
    xml = await readFile(sidecarPath, 'utf8');
  } catch {
    return null; // 不存在 / 读不动就当没有：XMP 不是唯一真相，日志与内存状态还在
  }
  const out: XmpMarks = {};
  const rating = RATING_ATTR.exec(xml) ?? RATING_EL.exec(xml);
  if (rating?.[1]) {
    const n = Number(rating[1]);
    if (n < 0) {
      out.stars = 0;
      out.del = true;
    } else {
      out.stars = n;
    }
  }
  // 兼容早期版本写的自造字段（新写的一律走 xmp:Rating）
  const del = DEL_ATTR.exec(xml) ?? DEL_EL.exec(xml);
  if (del?.[1]) out.del = del[1] === 'true' || del[1] === '1';
  return Object.keys(out).length ? out : null;
}

export type SidecarWrite = 'created' | 'updated' | 'unchanged';

/**
 * 把 `{stars, del}` 写进 sidecar。抛错表示写不进去（只读共享、权限、盘掉了），
 * 调用方据此把状态退回本地日志（见 marks.ts），不把它当致命错误。
 */
export async function writeXmpMarks(sidecarPath: string, marks: { stars: number; del: boolean }): Promise<SidecarWrite> {
  const rating = ratingOf(marks);
  let existing: string | null = null;
  try {
    existing = await readFile(sidecarPath, 'utf8');
  } catch {
    existing = null; // 不存在 / 读不动但可能写得动 —— 继续，按新建处理
  }
  if (existing !== null && currentRating(existing) === rating) return 'unchanged';
  const xml = existing === null ? packet(rating) : upsertRating(existing, rating);
  const tmp = `${sidecarPath}.aw-${process.pid}.tmp`;
  await writeFile(tmp, xml, 'utf8');
  await rename(tmp, sidecarPath);
  return existing === null ? 'created' : 'updated';
}

function currentRating(xml: string): number | null {
  const m = RATING_ATTR.exec(xml) ?? RATING_EL.exec(xml);
  return m?.[1] ? Number(m[1]) : null;
}

/** 已有的 XMP：只改那一个整数，其余（尤其 crs:* 显影参数）原样保留 */
function upsertRating(xml: string, rating: number): string {
  if (RATING_EL.test(xml)) return xml.replace(RATING_EL, `<xmp:Rating>${rating}</xmp:Rating>`);
  if (RATING_ATTR.test(xml)) return xml.replace(RATING_ATTR, `xmp:Rating="${rating}"`);
  // 没有这个字段：插进第一个 rdf:Description 里；连 Description 都没有就退回新建
  const open = /<rdf:Description\b[^>]*>/.exec(xml);
  if (open) {
    const at = open.index + open[0].length;
    return `${xml.slice(0, at)}\n   <xmp:Rating>${rating}</xmp:Rating>${xml.slice(at)}`;
  }
  return packet(rating);
}

function packet(rating: number): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="art-workspace">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:Rating>${rating}</xmp:Rating>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}
