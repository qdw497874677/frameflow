/** FilmLutStore：烘焙好的 LUT 落在数据目录 cache/film-luts/<sha256(键)>.cube，胶片目录存 catalog.json */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FilmLutStore } from '../../application/grading/ports.ts';
import type { FilmStock } from '../../domain/grading/film.ts';
import { formatCube, parseCube, type Lut3D } from '../../domain/grading/lut.ts';

export class DirFilmLutStore implements FilmLutStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'cache', 'film-luts');
  }

  private file(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.cube`);
  }

  async read(key: string): Promise<Lut3D | null> {
    try { return parseCube(await readFile(this.file(key), 'utf8')); } catch { return null; }
  }

  async write(key: string, lut: Lut3D): Promise<void> {
    await this.atomic(this.file(key), formatCube(lut, key));
  }

  async readCatalog(): Promise<FilmStock[] | null> {
    try {
      const v = JSON.parse(await readFile(join(this.dir, 'catalog.json'), 'utf8')) as unknown;
      return Array.isArray(v) ? (v as FilmStock[]) : null;
    } catch { return null; }
  }

  async writeCatalog(stocks: readonly FilmStock[]): Promise<void> {
    await this.atomic(join(this.dir, 'catalog.json'), JSON.stringify(stocks, null, 2));
  }

  private async atomic(file: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  }
}
