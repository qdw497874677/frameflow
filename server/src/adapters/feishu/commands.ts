/**
 * 飞书文本命令（F26）。群聊必须 @ 机器人才响应；私聊直接响应。未知命令回帮助。
 * 命令只打开卡片，不直接写标记、不直接派发；创建任务仍走「预览 → 确认」一次。
 */
export type CommandName = 'help' | 'list' | 'continue' | 'create';

const ALIASES: Record<string, CommandName> = {
  '帮助': 'help', help: 'help', '?': 'help', '？': 'help',
  '任务': 'list', '列表': 'list', '任务列表': 'list', list: 'list', tasks: 'list',
  '继续': 'continue', continue: 'continue', next: 'continue',
  '新建': 'create', '新建任务': 'create', '创建': 'create', '创建任务': 'create', create: 'create', new: 'create',
};

export interface ParsedCommand { readonly name: CommandName; readonly known: boolean }

/** 解析消息文本；返回 null 表示不该响应（群里没 @ 机器人） */
export function parseCommand(payload: Readonly<Record<string, unknown>>, sourceKind: 'group' | 'user'): ParsedCommand | null {
  if (sourceKind === 'group' && payload['mentioned'] !== true) return null;
  const text = typeof payload['text'] === 'string' ? payload['text'] : '';
  const word = text.trim().replace(/^\//, '').split(/\s+/)[0]?.toLowerCase() ?? '';
  const name = ALIASES[word];
  return name ? { name, known: true } : { name: 'help', known: false };
}
