#!/usr/bin/env node
/**
 * 后端端到端冒烟测试 —— 对着 `server/artworks.config.yaml` 里配的库跑一遍真实读写。
 *
 *   ./tools/dev.sh restart && node tools/e2e-api.mjs [base]
 *
 * 它会**真的动文件**（写 .xmp 侧车），所以只对测试库用。覆盖：
 * 健康检查 / 目录树 / 照片字段 / 朝向换宽高 / 缩略图三档来源 / 标注互斥与 XMP 回写 /
 * 变更日志 / 选择集 / API token（bearer 记为 AI）/ 手动重扫 / 回收站尚未实现。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787/api/v1';
let pass = 0;
let fail = 0;

function check(cond, name, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function req(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body, status: res.status, headers: res.headers };
}

const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function jpegSize(buf) {
  try {
    const m = await sharp(buf).metadata();
    return `${m.width}x${m.height}`;
  } catch {
    return 'not-a-jpeg';
  }
}

console.log(`\n=== 后端端到端冒烟：${BASE} ===\n`);

// ── 1. 健康与能力 ────────────────────────────────────────────────────────
const health = await req('/health');
check(health.status === 200 && health.body?.ok === true, 'GET /health', `version ${health.body?.version} roots ${JSON.stringify(health.body?.roots)}`);
const caps = await req('/capabilities');
check(caps.status === 200 && Array.isArray(caps.body?.jobs), 'GET /capabilities', `executors ${caps.body?.executors?.length}`);
const scanStatus = caps.body?.library;
check(scanStatus?.photos > 0, '扫描已完成', `photos ${scanStatus?.photos} files ${scanStatus?.files} errors ${scanStatus?.errors?.length ?? 0}`);

// ── 2. 根目录 ────────────────────────────────────────────────────────────
const roots = await req('/roots');
const root = roots.body.roots[0];
check(roots.status === 200 && root?.path?.startsWith('/'), 'GET /roots', `${root?.path} → ${root?.diskPath} n=${root?.photoCount} online=${root?.online}`);
check(typeof root?.diskPath === 'string' && existsSync(root.diskPath), 'root.diskPath 指向真实磁盘路径', root?.diskPath);

// ── 3. 目录树：从根一层层走到底，边走边验计数 ──────────────────────────
async function walk(dir, depth = 0) {
  const { body } = await req(`/folders?path=${encodeURIComponent(dir)}`);
  const kids = body?.folders ?? [];
  if (depth === 0) check(kids.length > 0, '目录树第一层非空', kids.map((f) => f.name).join(', '));
  for (const kid of kids) {
    if (kid.hasSubfolders) {
      const sub = await req(`/folders?path=${encodeURIComponent(kid.path)}`);
      check((sub.body?.folders?.length ?? 0) > 0, `中间目录能继续下钻 ${kid.path}`, `${sub.body?.folders?.length} 个子目录`);
      await walk(kid.path, depth + 1);
    } else {
      const photos = await req(`/photos?dir=${encodeURIComponent(kid.path)}&limit=100`);
      check(photos.body?.total >= 0, `叶子目录可列照片 ${kid.path}`, `n=${photos.body?.total}`);
    }
  }
}
await walk(root.path);

// ── 4. 照片字段与朝向 ────────────────────────────────────────────────────
const all = [];
async function collect(dir) {
  const { body } = await req(`/photos?dir=${encodeURIComponent(dir)}&limit=100`);
  for (const p of body?.items ?? []) all.push(p);
  const { body: listing } = await req(`/folders?path=${encodeURIComponent(dir)}`);
  for (const kid of listing?.folders ?? []) await collect(kid.path);
}
await collect(root.path);
const pairs = all.filter((p) => p.hasRaw && p.hasJpeg);
const raws = all.filter((p) => p.hasRaw && !p.hasJpeg);
const jpegs = all.filter((p) => !p.hasRaw && p.hasJpeg);
const videos = all.filter((p) => p.kind === 'video');
check(all.length >= 8, '整个库的照片数（含视频）', `n=${all.length}`);
check(!all.some((p) => p.displayName.startsWith('._')), 'macOS AppleDouble 幽灵照片已被跳过');
check(!all.some((p) => p.displayName === '.DS_Store'), '.DS_Store 不是照片');
check(pairs.length >= 4, 'RAW+JPEG 成对', `${pairs.length} 组：${pairs.map((p) => p.displayName).join(', ')}`);
check(raws.length >= 2, '单 RAW', `${raws.length} 张：${raws.map((p) => p.displayName).join(', ')}`);
check(jpegs.length >= 2, '单 JPEG', `${jpegs.length} 张：${jpegs.map((p) => p.displayName).join(', ')}`);
check(videos.length >= 2, '视频', `${videos.length} 个`);
// 格式覆盖：影调工程上这三家的 RAW 容器完全不同，都要进得来
const exts = (list) => list.map((p) => (p.rawPath ?? '').split('.').pop()?.toLowerCase()).filter(Boolean);
check(exts(pairs).includes('arw'), '索尼 ARW 成对在库里', exts(pairs).join(', '));
check(exts(pairs).includes('dng'), '理光 DNG 成对在库里');
check(exts(pairs).includes('rw2'), '松下 RW2 成对在库里');

const sony = pairs.find((p) => p.camera?.includes('ILCE') || p.camera?.includes('A7') || true);
const portrait = all.find((p) => p.orientation >= 5);
check(Boolean(portrait), '有竖构图照片（朝向 5-8）', portrait ? `${portrait.displayName} ori=${portrait.orientation} ${portrait.width}x${portrait.height} ar=${portrait.ar.toFixed(3)}` : '');
if (portrait) check(portrait.ar < 1, '竖构图宽高已对调（ar < 1）', `ar=${portrait.ar.toFixed(3)}`);

// 元数据完整性
const withExif = all.filter((p) => p.camera && p.capturedAt);
check(withExif.length >= 3, '读到了相机与拍摄时间', withExif.map((p) => p.camera).join(', '));
check(all.filter((p) => p.kind !== 'video').every((p) => (p.rawPath ?? p.jpegPath ?? '').startsWith('/')), '文件路径是虚拟路径（不泄露绝对路径；视频本来就没有单文件路径）');

// ── 5. 缩略图：三种来源 ──────────────────────────────────────────────────
async function thumb(id, size) {
  const res = await fetch(`${BASE}/photos/${encodeURIComponent(id)}/thumb?size=${size}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}
const jpegOnly = jpegs[0];
const t512 = await thumb(jpegOnly.id, 512);
check(t512.res.status === 200 && t512.buf.length > 1024, 'JPEG 照片出 512 缩略图', `${t512.res.headers.get('content-type')} ${t512.buf.length}B ${await jpegSize(t512.buf)} src=${t512.res.headers.get('x-preview-source')}`);
const t2048 = await thumb(jpegOnly.id, 2048);
check(t2048.res.status === 200 && t2048.buf.length > t512.buf.length, 'JPEG 照片出 2048 大图（给 AI 看的那档）', `${(t2048.buf.length / 1024).toFixed(0)}KB ${await jpegSize(t2048.buf)}`);
const etag = t512.res.headers.get('etag');
const again = await fetch(`${BASE}/photos/${encodeURIComponent(jpegOnly.id)}/thumb?size=512`, { headers: { 'if-none-match': etag ?? '' } });
check(again.status === 304, '缩略图 ETag → 304', etag ?? '');

const rawOnly = raws[0];
const rawThumb = await thumb(rawOnly.id, 2048);
const rawSrc = rawThumb.res.headers.get('x-preview-source');
check(rawThumb.res.status === 200 && rawThumb.buf.length > 1024, '单 RAW 从内嵌 JPEG 出预览（票 001 的关键路径）', `${rawSrc} ${(rawThumb.buf.length / 1024).toFixed(0)}KB ${await jpegSize(rawThumb.buf)}`);
check(rawSrc === 'embedded_jpeg', '来源标为 embedded_jpeg', String(rawSrc));

const video = videos[0];
const vres = await thumb(video.id, 512);
check(vres.res.status === 200 && vres.buf.length > 1024, '视频：ffmpeg 抽帧出封面（不再 422）', `HTTP ${vres.res.status} src=${vres.res.headers.get('x-preview-source')} ${(vres.buf.length / 1024).toFixed(0)}KB ${await jpegSize(vres.buf)} ${vres.body?.error ?? ''}`);
check(vres.res.headers.get('x-preview-source') === 'video_poster', '视频封面来源标为 video_poster');
const videoDisk = join(root.diskPath, (video.videoPath ?? '').replace(`/${root.id}`, ''));
const videoStat = existsSync(videoDisk) ? statSync(videoDisk) : null;
check(Boolean(videoStat), '视频在盘上有实体文件', video.videoPath ?? '（没有 videoPath）');
check(video.sizeBytes === videoStat?.size, '视频记录带上真实 sizeBytes（不再是 undefined）', `${video.sizeBytes} vs ${videoStat?.size}`);
check(
  Boolean(videoStat) && Math.abs(Date.parse(video.mtime) - videoStat.mtimeMs) < 1000,
  '视频 mtime 来自磁盘，不是请求时刻',
  `api=${video.mtime} disk=${videoStat ? new Date(videoStat.mtimeMs).toISOString() : '—'}`,
);
check(video.preview === 'video_poster', '视频的 preview 标成 video_poster', String(video.preview));
if (videoStat) {
  const vfile = await fetch(`${BASE}/photos/${encodeURIComponent(video.id)}/file?variant=video`);
  const vbuf = Buffer.from(await vfile.arrayBuffer());
  check(vfile.status === 200 && vbuf.length === videoStat.size, '视频原文件能下载（variant=video）', `HTTP ${vfile.status} ${vbuf.length}B`);
}

// ── 5b. 多 RAW 格式：没有外拍 JPEG 时抽内嵌预览 ───────────────────────
for (const [label, name] of [
  ['DNG（理光）', 'R0001360'],
  ['RW2（松下）', '_1110316'],
]) {
  const rec = raws.find((p) => p.displayName === name && p.dir.includes('单RAW'));
  if (!rec) {
    check(false, `${label} 单 RAW 样本在库里`, '没找到（测试数据没拷进去？）');
    continue;
  }
  const got = await thumb(rec.id, 2048);
  check(
    got.res.status === 200 && got.buf.length > 1024,
    `${label} 单 RAW 抽出内嵌预览（票 001 第 2 层）`,
    `HTTP ${got.res.status} src=${got.res.headers.get('x-preview-source')} ${(got.buf.length / 1024).toFixed(0)}KB ${await jpegSize(got.buf)} ${got.body?.error ?? ''}`,
  );
}

// 胶片扫描：没有相机 EXIF，不该崩，也不该假装有相机
const scan = jpegs.find((p) => p.displayName.startsWith('lr-'));
check(Boolean(scan), '胶片扫描的 JPEG 被收录', scan ? `${scan.displayName} camera=${scan.camera ?? '（无）'} capturedAt=${scan.capturedAt ?? '（无，回落 mtime）'}` : '没找到');
if (scan) {
  const got = await thumb(scan.id, 512);
  check(got.res.status === 200 && got.buf.length > 1024, '胶片扫描出缩略图', `HTTP ${got.res.status} ${(got.buf.length / 1024).toFixed(0)}KB ${await jpegSize(got.buf)}`);
}

// ── 6. 标注：写状态 + 回写 XMP ──────────────────────────────────────────
const target = pairs[0];
const diskDir = join(root.diskPath, target.dir.replace(`/${root.id}`, '').replace(/^\//, ''));
const stem = target.displayName;
const sidecar = join(diskDir, `${stem}.xmp`);

async function putMarks(items, headers) {
  return req('/marks', { method: 'PUT', headers: { ...json({ items }).headers, ...(headers ?? {}) }, body: JSON.stringify({ items }) });
}

const m3 = await putMarks([{ id: target.id, stars: 3 }]);
check(m3.status === 200 && m3.body.results[0].stars === 3, 'PUT /marks 打三星', JSON.stringify(m3.body.results[0]));
check(existsSync(sidecar), '照片旁边生成了共享 XMP 侧车文件', sidecar);
// 我们写元素写法（<xmp:Rating>3</xmp:Rating>），Lightroom 写属性写法 —— 两种都算对
function ratingIn(xml) {
  const m = xml.match(/xmp:Rating\s*=\s*"(-?\d)"/) ?? xml.match(/<xmp:Rating>\s*(-?\d)\s*<\/xmp:Rating>/);
  return m ? Number(m[1]) : null;
}
const xmp3 = existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : '';
check(ratingIn(xmp3) === 3, 'XMP 里是 xmp:Rating=3（Lightroom 认得）', `读到 ${ratingIn(xmp3)}`);

const md = await putMarks([{ id: target.id, del: true }]);
check(md.status === 200 && md.body.results[0].del === true && md.body.results[0].stars === 0, '待删与星级互斥（打待删清星）', JSON.stringify(md.body.results[0]));
const xmpD = readFileSync(sidecar, 'utf8');
check(ratingIn(xmpD) === -1, '待删在 XMP 里记成 Rating=-1（Lightroom 的 rejected）', `读到 ${ratingIn(xmpD)}`);

const hist = await req('/marks/history?limit=10');
const mine = hist.body.items.filter((h) => h.photoId === target.id);
check(mine.length >= 2, '变更日志记下了每一次真实变化', mine.map((h) => `${h.field} ${h.from}→${h.to} by ${h.by}/${h.channel}`).join(' | '));

const restore = await putMarks([{ id: target.id, stars: 2, del: false }]);
check(restore.body.results[0].stars === 2 && restore.body.results[0].del === false, '改回两星（互斥自动解除）', JSON.stringify(restore.body.results[0]));

// ── 7. 成对原子：标注落到 raw+jpeg 一对上 ────────────────────────────────
check(target.hasRaw && target.hasJpeg, '标注目标是一对 RAW+JPEG', `${stem}`);

// ── 8. 选择集 ────────────────────────────────────────────────────────────
const selStar = await req(`/photos?dir=${encodeURIComponent(target.dir)}&sel=${encodeURIComponent('stars>=2')}`);
check(selStar.body.items.some((p) => p.id === target.id), 'sel=stars>=2 能筛出来');
const selDel = await req(`/photos?dir=${encodeURIComponent(target.dir)}&sel=${encodeURIComponent('del')}`);
check(!selDel.body.items.some((p) => p.id === target.id), 'sel=del 不含它（已解除待删）');
const selKind = await req(`/photos?dir=${encodeURIComponent(target.dir)}&sel=${encodeURIComponent('kind:video')}`);
check(selKind.body.items.length === 0, 'sel=kind:video 在这个目录里是空的');

// ── 9. API token：AI/CLI 凭据 ────────────────────────────────────────────
const tok = await req('/api-tokens', { method: 'POST', ...json({ label: 'e2e-agent', scope: 'full' }) });
check(tok.status === 201 && tok.body.token?.startsWith('aw_'), '签发 API token（明文只出现一次）', tok.body.id);
check(typeof tok.body.linkToken === 'string' && tok.body.linkToken.length > 20, '签发时一并给出链接 token（缩略图自认证）', `${String(tok.body.linkToken).slice(0, 12)}… exp=${tok.body.linkExpiresAt}`);
check(
  String(tok.body.thumbUrlTemplate ?? '').includes('{id}') && String(tok.body.thumbUrlTemplate ?? '').includes('{size}'),
  '给出缩略图 URL 模板（{id}/{size} 自己填）',
  String(tok.body.thumbUrlTemplate).slice(0, 80),
);
const linkThumb = await fetch(`${BASE}/photos/${encodeURIComponent(jpegOnly.id)}/thumb?size=512&t=${encodeURIComponent(tok.body.linkToken)}`);
check(linkThumb.status === 200, '链接 token 能取缩略图（图像加载器不用带 header）', `HTTP ${linkThumb.status} src=${linkThumb.headers.get('x-preview-source')}`);
const tampered = `${String(tok.body.linkToken).slice(0, -2)}xx`;
const badLink = await fetch(`${BASE}/photos/${encodeURIComponent(jpegOnly.id)}/thumb?size=512&t=${encodeURIComponent(tampered)}`);
check(
  health.body?.authRequired ? badLink.status === 401 : badLink.status === 200,
  health.body?.authRequired ? '改过的链接 token 被拒（401）' : '改过的链接 token 在免认证模式下无所谓',
  `HTTP ${badLink.status}`,
);
const aiMark = await putMarks([{ id: target.id, stars: 4 }], { authorization: `Bearer ${tok.body.token}` });
check(aiMark.status === 200, 'Bearer token 能调 PUT /marks');
const aiHist = await req('/marks/history?limit=5');
check(aiHist.body.items[0]?.by === 'ai:e2e-agent', 'AI 的改动记成 by=ai:e2e-agent', JSON.stringify({ by: aiHist.body.items[0]?.by, channel: aiHist.body.items[0]?.channel }));
const listed = await req('/api-tokens');
check((listed.body.tokens ?? []).some((t) => t.id === tok.body.id), 'token 列表用 tokens 字段列出（不泄露明文）', `lastUsedAt=${listed.body.tokens?.[0]?.lastUsedAt ?? '—'}`);
const revoked = await req(`/api-tokens?id=${tok.body.id}`, { method: 'DELETE' });
check(revoked.status === 204, 'token 可撤销');
const linkAfterRevoke = await fetch(`${BASE}/photos/${encodeURIComponent(jpegOnly.id)}/thumb?size=512&t=${encodeURIComponent(tok.body.linkToken)}`);
check(
  health.body?.authRequired ? linkAfterRevoke.status === 401 : linkAfterRevoke.status === 200,
  health.body?.authRequired ? '撤销 API token 后链接 token 一起失效（401）' : '免认证模式下链接 token 照旧',
  `HTTP ${linkAfterRevoke.status}`,
);
const afterRevoke = await putMarks([{ id: target.id, stars: 1 }], { authorization: `Bearer ${tok.body.token}` });
const authRequired = health.body?.authRequired === true;
check(
  authRequired ? afterRevoke.status === 401 : afterRevoke.status === 200,
  authRequired ? '撤销后 token 立刻失效（401）' : '免认证模式下撤销后照旧放行（但来源退回 me）',
  `HTTP ${afterRevoke.status} authRequired=${authRequired}`,
);

// ── 10. 手动重扫 + 回收站（尚未实现）──────────────────────────────────────
const rescan = await req('/scan', { method: 'POST' });
check(rescan.status === 202, 'POST /scan 触发重扫', JSON.stringify(rescan.body));

// ── 11. 回收站：成对搬走 → 还出得了图 → 还原 → 再进 → 真删 ─────────────
const diskOf = (virtual) => join(root.diskPath, virtual.replace(`/${root.id}`, ''));
const pair = all.find((p) => p.kind === 'photo' && p.hasRaw && p.hasJpeg);
check(Boolean(pair), '找到成对样本用于回收站用例', pair?.displayName ?? 'none');
if (pair) {
  const rawDisk = diskOf(pair.rawPath);
  const jpegDisk = diskOf(pair.jpegPath);
  const trashDir = join(dirname(rawDisk), '.trash');

  const moved = await req('/trash', { method: 'POST', ...json({ ids: [pair.id] }) });
  check(moved.status === 200 && moved.body.ok === 1, 'POST /trash 移入回收站', JSON.stringify(moved.body));
  check(!existsSync(rawDisk) && !existsSync(jpegDisk), 'RAW 与 JPEG 一起搬走了（成对）');
  check(existsSync(trashDir), '搬进了照片旁的 .trash/（同共享，rename 才原子）', trashDir);

  const bin = await req('/trash');
  const entry = (bin.body.items ?? []).find((t) => t.photoId === pair.id);
  check(Boolean(entry) && entry.fromDir === pair.dir, 'GET /trash 里有这条，且记着原目录', `dir=${entry?.dir}`);
  check(entry?.hasRaw === true && entry?.hasJpeg === true, '记录里带着成对信息', `${entry?.sizeBytes} bytes`);

  const stillListed = await req(`/photos?dir=${encodeURIComponent(pair.dir)}`);
  check(!(stillListed.body.items ?? []).some((p) => p.id === pair.id), '已删的不再出现在挑片列表里');

  const binThumb = await req(`/photos/${encodeURIComponent(pair.id)}/thumb?size=512`);
  check(binThumb.status === 200, '回收站里的还能出缩略图（读 .trash 里的文件）', `source=${binThumb.headers.get('x-preview-source')}`);

  const trashHist = await req(`/marks/history?photoId=${encodeURIComponent(pair.id)}&limit=2`);
  check(trashHist.body.items[0]?.channel === 'trash', '搬运时把标记清掉，日志记 channel=trash', `${trashHist.body.items[0]?.field} ${trashHist.body.items[0]?.from}→${trashHist.body.items[0]?.to}`);

  const restored = await req('/trash/restore', { method: 'POST', ...json({ ids: [pair.id] }) });
  check(restored.status === 200 && restored.body.ok === 1, 'POST /trash/restore 还原', JSON.stringify(restored.body));
  check(existsSync(rawDisk) && existsSync(jpegDisk), 'RAW 与 JPEG 都回到了原位');
  const backAgain = await req(`/photos?dir=${encodeURIComponent(pair.dir)}`);
  check((backAgain.body.items ?? []).some((p) => p.id === pair.id), '还原后重新出现在挑片列表里');
}

// 真删（唯一会 rmSync 的入口）用一张临时照片试，不拿库里的真片开刀
const probeDir = join(root.diskPath, '_回收站真删探针');
mkdirSync(probeDir, { recursive: true });
await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 40, b: 60 } } })
  .jpeg({ quality: 70 })
  .toFile(join(probeDir, 'PROBE.JPG'));
await req('/scan', { method: 'POST' });
let probe = null;
for (let i = 0; i < 80 && !probe; i++) {
  // 扫描进行中时新落的文件这一遍看不见：每两秒补一次 /scan（它会排队补扫）
  if (i > 0 && i % 8 === 0) await req('/scan', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 250));
  const { body } = await req(`/photos?dir=${encodeURIComponent('/' + root.id + '/_回收站真删探针')}`);
  probe = (body?.items ?? []).find((p) => p.displayName === 'PROBE') ?? null;
}
check(Boolean(probe), '探针照片被扫进来了', probe?.id ?? 'none');
if (probe) {
  const probeDisk = diskOf(probe.jpegPath);
  check(existsSync(probeDisk), '探针文件在盘上', probeDisk);
  await req('/trash', { method: 'POST', ...json({ ids: [probe.id] }) });
  const refused = await req('/trash', { method: 'DELETE', ...json({ ids: [probe.id] }) });
  check(refused.status === 400, '不带 ?confirm=true 时拒绝真删', refused.body?.error ?? '');
  const purged = await req('/trash?confirm=true', { method: 'DELETE', ...json({ ids: [probe.id] }) });
  check(purged.status === 200 && purged.body.ok === 1, 'DELETE /trash?confirm=true 真删', JSON.stringify(purged.body));
  check(!existsSync(probeDisk), '磁盘上真没了');
  check(!(await req('/trash')).body.items.some((t) => t.photoId === probe.id), '回收站记录也没了');
  check(!existsSync(join(probeDir, '.trash')), '.trash 目录随真删收掉');
}
rmSync(probeDir, { recursive: true, force: true });
await req('/scan', { method: 'POST' });

// 收尾：把测试库恢复成「一张两星 + 其余未标」
await putMarks([{ id: target.id, stars: 2, del: false }]);
for (const p of all) if (p.id !== target.id && (p.stars > 0 || p.del)) await putMarks([{ id: p.id, stars: 0, del: false }]);

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
