import { formatShortTime } from '@/core/format';
import type { JobEvent, JobEventType, JobItem, JobState } from '@/core/types';

/** 任务的显示语言：面向用户一律说「任务」，不说 job（GLOSSARY.md） */

export const STATE_LABEL: Record<JobState, string> = {
  planned: '预演',
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被打断',
};

/** 状态色：进行中 = 金色（在跑），完成 = 绿，出事 = 红，其余灰 */
export const STATE_TONE: Record<JobState, 'gold' | 'ok' | 'bad' | 'muted'> = {
  planned: 'muted',
  queued: 'gold',
  running: 'gold',
  done: 'ok',
  failed: 'bad',
  interrupted: 'bad',
  cancelled: 'muted',
};

/** 「还没收摊」的状态：列表的「进行中」筛选与按钮置灰都按它算 */
export const ACTIVE_STATES: JobState[] = ['planned', 'queued', 'running', 'interrupted'];

export function isActive(state: JobState): boolean {
  return ACTIVE_STATES.includes(state);
}

/** 能力名 → 人话；没登记的 kind 原样显示（插件可以贡献新 kind） */
const KIND_LABEL: Record<string, string> = {
  annotate: '批注',
  grade: '风格',
  export: '导出',
  process: '处理',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export const EVENT_LABEL: Record<JobEventType, string> = {
  created: '建任务',
  dispatched: '已派发',
  inbound: '收到回流',
  applied: '写入标注',
  skipped: '跳过',
  conflict: '冲突',
  failed: '失败',
  cancelled: '取消',
  undone: '撤销',
  done: '收尾',
  note: '备注',
};

/** 事件色调：失败/冲突红，撤销/取消灰，写入绿，其余中性 */
export function eventTone(type: JobEventType): 'ok' | 'bad' | 'muted' | 'default' {
  if (type === 'failed' || type === 'conflict') return 'bad';
  if (type === 'cancelled' || type === 'undone' || type === 'skipped') return 'muted';
  if (type === 'applied' || type === 'done') return 'ok';
  return 'default';
}

/** ISO → 「MM-DD HH:mm」（本地时区）；空值给个占位 */
export function fmtTime(iso?: string | null): string {
  return formatShortTime(iso);
}

/** items 里一行「标成了什么」：★n / 待删 / 未标 */
export function itemMark(item: JobItem): string {
  if (item.del) return '待删';
  if (typeof item.stars === 'number' && item.stars > 0) return `★${item.stars}`;
  return '未标';
}

/** 事件的 from → to 显示：布尔值转成人话 */
export function fmtValue(v: JobEvent['from']): string {
  if (v === true) return '待删';
  if (v === false) return '非待删';
  if (typeof v === 'number') return v > 0 ? `★${v}` : '未标';
  return String(v ?? '—');
}

/** 事件一行的人话描述（谁把哪张从什么改成了什么） */
export function describeEvent(ev: JobEvent, itemOf: (id: string) => JobItem | undefined): string {
  const name = ev.photoId ? (itemOf(ev.photoId)?.displayName ?? ev.photoId) : '';
  const head = EVENT_LABEL[ev.type] ?? ev.type;
  if (ev.type === 'applied' && name) {
    return `${head}：${name}${ev.from !== undefined && ev.from !== null ? `（${fmtValue(ev.from)} → ${fmtValue(ev.to)}）` : ` → ${fmtValue(ev.to)}`}`;
  }
  if (ev.type === 'skipped' && name) return `${head}：${name}（重复的 clientRef）`;
  if (ev.type === 'dispatched') return `${head}${ev.channel ? `：${ev.channel}` : ''}`;
  if (ev.type === 'note' || ev.type === 'done') return `${head}${ev.note ? `：${ev.note}` : ''}`;
  return name ? `${head}：${name}` : head;
}
