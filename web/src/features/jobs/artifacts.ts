/** 产物的人话标签与说明：url = 批注链接（带范围凭据）；dir = 导出目录 */
export function artifactText(kind: string, linkUsable: boolean): { label: string; hint: string | null } {
  if (kind === 'url') {
    return {
      label: '批注链接',
      hint: linkUsable ? '这条链接自带凭据（范围 token）：批注人不用登录，只能看这个任务里的照片、只能写回这个任务。' : '任务已取消或失败，这条链接已失效。',
    };
  }
  if (kind === 'dir') return { label: '导出目录', hint: '成品 JPEG 在这个目录里（服务器数据目录），原片没动。' };
  return { label: kind, hint: null };
}
