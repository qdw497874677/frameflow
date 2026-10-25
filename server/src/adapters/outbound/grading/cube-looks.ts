/** LookSource：内置风格 = server/assets/looks 下的 looks.json + <id>.cube（许可见同目录 NOTICE） */
import fs from 'node:fs';
import path from 'node:path';
import { parseCube, type Lut3D } from '../../../domain/grading/lut.ts';
import type { Look } from '../../../domain/grading/recipe.ts';
import type { LookSource } from '../../../application/grading/ports.ts';

export const BUILTIN_LOOKS_DIR = path.join(import.meta.dirname, '..', '..', '..', '..', 'assets', 'looks');

export class CubeLookSource implements LookSource {
  private readonly looks: Look[];
  private readonly cache = new Map<string, Lut3D>();
  readonly dir: string;

  constructor(dir: string = BUILTIN_LOOKS_DIR) {
    this.dir = dir;
    const manifest = path.join(dir, 'looks.json');
    this.looks = fs.existsSync(manifest) ? (JSON.parse(fs.readFileSync(manifest, 'utf8')) as Look[]) : [];
  }

  list(): Look[] {
    return this.looks.map((l) => ({ ...l }));
  }

  /** 原始 .cube 文本（给浏览器 WebGL 预览，与导出读同一份） */
  cubeText(id: string): string | null {
    if (!this.looks.some((l) => l.id === id)) return null;
    const file = path.join(this.dir, `${id}.cube`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }

  async load(id: string): Promise<Lut3D | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const text = this.cubeText(id);
    if (text === null) return null;
    const lut = parseCube(text);
    this.cache.set(id, lut);
    return lut;
  }
}
