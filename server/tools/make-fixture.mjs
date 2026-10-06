#!/usr/bin/env node
/**
 * 造一棵假照片库，用来在本机验证扫描 / 配对 / 缩略图 / 标注回写。
 * 这台机器上没有真实照片，所以需要它。
 *
 *   node tools/make-fixture.mjs [/tmp/artworks-fixture]
 *
 * 造出来的形状刻意模仿真实习惯：项目目录 → 机身 → 照片；RAW+JPEG 双出、单 RAW、
 * 竖构图、侧车 .xmp、以及必须被忽略的 .trash / @eaDir。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exiftool } from 'exiftool-vendored';
import sharp from 'sharp';

const root = process.argv[2] ?? '/tmp/artworks-fixture';
rmSync(root, { recursive: true, force: true });

const PALETTES = [
  [0x1b2a4a, 0x8f7f5a],
  [0x2a1030, 0xc05a4a],
  [0x0e2a20, 0x6aa07a],
  [0x241408, 0xb08448],
];

async function photo(file, w, h, i) {
  const [a, b] = PALETTES[i % PALETTES.length];
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: `#${a.toString(16).padStart(6, '0')}` },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#${b.toString(16).padStart(6, '0')}"/><stop offset="1" stop-color="#000" stop-opacity="0.2"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.3}" cy="${h * 0.28}" r="${w * 0.045}" fill="#f0e6c8"/></svg>`,
        ),
        blend: 'over',
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  writeFileSync(file, buf);
  return file;
}

try {
  const base = join(root, '2026-冰岛');
  const a7 = join(base, 'A7M4');
  const fuji = join(base, 'Fuji X-T5');
  mkdirSync(a7, { recursive: true });
  mkdirSync(fuji, { recursive: true });

  // 3:2 双出（RAW+JPEG）
  await photo(join(a7, '_DSC0001.JPG'), 1600, 1067, 0);
  writeFileSync(join(a7, '_DSC0001.ARW'), Buffer.alloc(2048));
  await photo(join(a7, '_DSC0002.JPG'), 1600, 1067, 1);
  writeFileSync(join(a7, '_DSC0002.ARW'), Buffer.alloc(2048));
  // 竖构图
  await photo(join(a7, '_DSC0003.JPG'), 1067, 1600, 2);
  writeFileSync(join(a7, '_DSC0003.ARW'), Buffer.alloc(2048));
  // 只有 RAW，没有外拍 JPEG —— 预览要靠内嵌抽取，这里抽不出来（假的 RAW），正好测降级
  writeFileSync(join(a7, '_DSC0004.ARW'), Buffer.alloc(4096));
  // 带侧车 .xmp 且里面写着「四星」—— 测只读共享与 XMP 作基线
  await photo(join(a7, '_DSC0005.JPG'), 1600, 1067, 3);
  writeFileSync(
    join(a7, '_DSC0005.xmp'),
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>\n`,
  );
  // 富士那台
  await photo(join(fuji, 'DSCF1001.JPG'), 1600, 1067, 2);
  writeFileSync(join(fuji, 'DSCF1001.RAF'), Buffer.alloc(2048));

  // 写一点真实的相机标签（顺便验证 exiftool 能读回来）
  const tags = {
    '2026-冰岛/A7M4': { Model: 'Sony A7M4', LensModel: 'FE 24-70mm F2.8 GM II', DateTimeOriginal: '2026-03-14T19:20:31' },
    '2026-冰岛/Fuji X-T5': { Model: 'Fuji X-T5', LensModel: 'XF 35mm F1.4', DateTimeOriginal: '2026-03-15T07:05:02' },
  };
  for (const [rel, t] of Object.entries(tags)) {
    const dir = join(root, rel);
    for (const name of ['_DSC0001.JPG', '_DSC0002.JPG', '_DSC0003.JPG', '_DSC0005.JPG', 'DSCF1001.JPG']) {
      try {
        await exiftool.write(join(dir, name), t, ['-overwrite_original']);
      } catch {
        // 假文件写不进去也不影响扫描
      }
    }
  }

  // 必须被忽略的东西
  mkdirSync(join(a7, '.trash'), { recursive: true });
  writeFileSync(join(a7, '.trash', 'deleted.JPG'), Buffer.alloc(64));
  mkdirSync(join(base, '@eaDir'), { recursive: true });
  writeFileSync(join(base, '@eaDir', 'thumb.JPG'), Buffer.alloc(64));
} finally {
  await exiftool.end();
}

console.log(`假库造好了：${root}`);
