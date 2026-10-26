/**
 * ExportMetadata：用 exiftool 把原片的「这张照片是什么」抄到成品上（sharp 出图时元数据全丢）。
 *
 * 抄：拍摄时间（含时区/亚秒）、相机/镜头、曝光参数、作者/版权（EXIF + XMP）。
 * 不抄：朝向（像素已摆正，强制写 1）、ICC（成品是渲染时嵌的 sRGB，不动）、缩略图、厂商私有块。
 * GPS：缺省剥掉（成品多半要外发），`keepGps` 时才抄。
 * 来源取原片（同名 JPEG 优先、否则 RAW 本身 —— RAW 的像素虽来自内嵌 JPEG，EXIF 在 RAW 主文件里最全）。
 */
import { exiftool } from 'exiftool-vendored';
import type { PhotoRecord } from '../../../domain/photo.ts';
import type { ExportMetadata } from '../../../application/grading/ports.ts';

/** 要抄的标签（exiftool 组名写法；源里没有的自动跳过） */
const CARRY = [
  'EXIF:DateTimeOriginal', 'EXIF:CreateDate', 'EXIF:OffsetTime*', 'EXIF:SubSecTime*',
  'EXIF:Make', 'EXIF:Model', 'EXIF:LensMake', 'EXIF:LensModel', 'EXIF:LensInfo',
  'EXIF:ExposureTime', 'EXIF:FNumber', 'EXIF:ISO', 'EXIF:FocalLength', 'EXIF:FocalLengthIn35mmFormat',
  'EXIF:ExposureProgram', 'EXIF:ExposureCompensation', 'EXIF:MeteringMode', 'EXIF:Flash', 'EXIF:WhiteBalance',
  'EXIF:Artist', 'EXIF:Copyright', 'XMP-dc:Creator', 'XMP-dc:Rights', 'XMP-xmp:Rating',
];

export interface SourceLookup {
  get(id: string): PhotoRecord | undefined;
}

export class ExiftoolMetadata implements ExportMetadata {
  private readonly lib: SourceLookup;

  constructor(lib: SourceLookup) {
    this.lib = lib;
  }

  async carry(photoId: string, outPath: string, opts: { keepGps: boolean }): Promise<void> {
    const rec = this.lib.get(photoId);
    const src = rec?.jpeg?.path ?? rec?.raw?.path;
    if (!src) throw new Error(`照片不在库里了：${photoId}`);
    const tags = [...CARRY, ...(opts.keepGps ? ['GPS:all'] : [])].map((t) => `-${t}`);
    // 「源里有个 Composite:Lens 没法写」这类只是警告；真写坏了 exiftool 会抛
    await exiftool.write(outPath, {}, {
      writeArgs: ['-tagsFromFile', src, ...tags, '-IFD0:Orientation#=1', '-overwrite_original'],
    });
  }
}
