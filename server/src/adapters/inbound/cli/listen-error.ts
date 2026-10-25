/** 端口起不来时给一句人话（而不是一屏堆栈）；认不出的错误原样带上 message */
export function listenFailureMessage(err: unknown, host: string, port: number): string {
  const code = (err as { code?: unknown } | null)?.code;
  const where = `${host}:${port}`;
  if (code === 'EADDRINUSE') return `启动失败：端口 ${where} 已被占用。可能已经有一个 FrameFlow 在跑；先停掉它，或在配置里换一个 port。`;
  if (code === 'EACCES') return `启动失败：没有权限监听 ${where}（1024 以下的端口需要管理员权限），请换一个 port。`;
  if (code === 'EADDRNOTAVAIL') return `启动失败：本机没有地址 ${host}，请检查配置里的 host。`;
  return `启动失败：监听 ${where} 出错：${err instanceof Error ? err.message : String(err)}`;
}
