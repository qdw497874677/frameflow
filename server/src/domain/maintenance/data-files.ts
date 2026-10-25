/**
 * 数据目录里文件的体检规则（纯函数）。
 *
 * jsonl 是追加日志：崩溃可能留下一条没写完的尾行，读取方本来就会丢掉它，所以只算警告；
 * 中间行坏了说明文件被外力改过，算错误。json 是整体替换写入，解析不了就是错误。
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
  if (tail.trim()) findings.push({ file, severity: 'warning', message: '末尾有未写完的行（崩溃残留，读取时会被忽略）' });
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
