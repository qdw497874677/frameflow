/**
 * 数据目录里文件的体检规则（纯函数）。
 *
 * jsonl 是追加日志：崩溃可能留下一条没写完的尾行，启动时会被安全截掉，所以只算警告；
 * 中间行坏了说明文件被外力改过，算错误 —— 用 `npm run repair` 备份原文件后剔除坏行。json 是整体替换写入，解析不了就是错误。
 * 残留的 *.tmp 是原子写入中途崩溃的痕迹，正式文件仍完好，只提示清理。
 */

export type Severity = 'error' | 'warning';
export interface Finding { file: string; severity: Severity; message: string }

export function kindOf(name: string): 'jsonl' | 'json' | 'tmp' | null {
  if (name.endsWith('.tmp')) return 'tmp';
  if (name.endsWith('.jsonl')) return 'jsonl';
  if (name.endsWith('.json')) return 'json';
  return null;
}

function parses(line: string): boolean {
  try { JSON.parse(line); return true; } catch { return false; }
}

export function checkJsonl(file: string, text: string): Finding[] {
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  const bad = lines.flatMap((l, i) => (l.trim() && !parses(l) ? [i + 1] : []));
  const findings: Finding[] = bad.map((n) => ({ file, severity: 'error', message: `第 ${n} 行不是合法 JSON` }));
  if (tail.trim()) findings.push({ file, severity: 'warning', message: '末尾有未写完的行（崩溃残留，启动时会安全截掉）' });
  return findings;
}

export function checkJson(file: string, text: string): Finding[] {
  return parses(text) ? [] : [{ file, severity: 'error', message: '不是合法 JSON' }];
}

export function checkFile(file: string, text: string): Finding[] {
  const kind = kindOf(file);
  if (kind === 'jsonl') return checkJsonl(file, text);
  if (kind === 'json') return checkJson(file, text);
  if (kind === 'tmp') return [{ file, severity: 'warning', message: '原子写入残留的临时文件，可删除' }];
  return [];
}

export interface JsonlRepair { text: string; droppedLines: number[]; tailRemoved: boolean }
export interface JsonlRefusal { refused: string; droppedLines: number[] }

/** 带版本号的行（标注事务信封）：解析得出 version 字段，或坏行里看得出 "version" 键 */
function versioned(line: string): boolean {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && 'version' in v;
  } catch { return /"version"\s*:/.test(line); }
}

/**
 * 剔除 jsonl 里不是合法 JSON 的完整行和没写完的尾行；无需修复时返回 null。
 * preserveVersioned（标注日志用）：带版本的事务行按 revision 链环环相扣，
 * 剔掉其中一行或剔掉它们前面的任何一行都会让后面所有版本作废 —— 这种情况拒绝改写，交给人处理。
 */
export function repairJsonl(text: string, opts: { preserveVersioned?: boolean } = {}): JsonlRepair | JsonlRefusal | null {
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  const tailRemoved = tail.trim() !== '';
  const droppedLines: number[] = [];
  const kept = lines.filter((l, i) => {
    const ok = !l.trim() || parses(l);
    if (!ok) droppedLines.push(i + 1);
    return ok;
  });
  if (!tailRemoved && droppedLines.length === 0) return null;
  if (opts.preserveVersioned) {
    const first = droppedLines[0];
    const breaksChain = droppedLines.some((n) => versioned(lines[n - 1])) ||
      (first !== undefined && lines.slice(first).some((l) => l.trim() && versioned(l)));
    if (breaksChain) return { refused: '坏行涉及带版本的标注事务，剔除会丢失版本链；文件未改动，请从备份恢复', droppedLines };
  }
  return { text: kept.map((l) => `${l}\n`).join(''), droppedLines, tailRemoved };
}
