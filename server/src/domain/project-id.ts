/**
 * 项目（根）id 的校验：根 id 来自用户起的目录名，可以是中文等 Unicode。
 * 规则：NFC 规范化后 1–128 个字符；不含控制字符、路径分隔符（/ \）；首尾不能是空白；不能是 `.` / `..`。
 * 飞书群 / 用户 id（oc_ / ou_）不走这里，仍用 ASCII 严格模式。
 */

const MAX = 128;
// \p{Cc} 控制字符、\p{Cf} 不可见格式字符（零宽等）、\p{Zl}\p{Zp} 行/段分隔符
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/u;

/** 合法则返回 NFC 规范化后的 id，否则 null。 */
export function normalizeProjectId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC');
  if (s.length === 0 || [...s].length > MAX || s.trim() !== s) return null;
  if (s === '.' || s === '..' || FORBIDDEN.test(s)) return null;
  return s;
}
