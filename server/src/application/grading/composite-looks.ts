/** 多个风格来源合成一个（内置 .cube + 光谱胶片 + 以后的用户导入）；id 先到先得 */
import type { Lut3D } from '../../domain/grading/lut.ts';
import type { Effect } from '../../domain/grading/effects.ts';
import type { FilmEffects } from '../../domain/grading/film.ts';
import type { Look } from '../../domain/grading/recipe.ts';
import type { LookSource } from './ports.ts';

export interface NamedLookSource {
  /** 来源名（给前端区分 / 展示许可） */
  readonly kind: string;
  readonly source: LookSource;
}

export class CompositeLookSource implements LookSource {
  private readonly sources: readonly NamedLookSource[];
  constructor(sources: readonly NamedLookSource[]) { this.sources = sources; }

  /** 带来源的列表；后面来源里与前面重名的 id 被忽略 */
  entries(): Array<Look & { kind: string }> {
    const seen = new Set<string>();
    const out: Array<Look & { kind: string }> = [];
    for (const { kind, source } of this.sources) {
      for (const look of source.list()) {
        if (seen.has(look.id)) continue;
        seen.add(look.id);
        out.push({ ...look, kind });
      }
    }
    return out;
  }

  list(): Look[] {
    return this.entries().map(({ kind: _kind, ...look }) => look);
  }

  ownerOf(id: string): NamedLookSource | null {
    for (const s of this.sources) if (s.source.list().some((l) => l.id === id)) return s;
    return null;
  }

  frameEffect(id: string, strength: number, film: FilmEffects): Effect | null {
    return this.ownerOf(id)?.source.frameEffect?.(id, strength, film) ?? null;
  }

  async load(id: string): Promise<Lut3D | null> {
    return (await this.ownerOf(id)?.source.load(id)) ?? null;
  }
}
