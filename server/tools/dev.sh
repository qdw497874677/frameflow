#!/usr/bin/env bash
# 开发期起停脚本。
#
# 别用 `pkill -f "node src/index.ts"` —— 那条命令会把你**自己这条 shell** 一起杀掉
# （你 shell 的命令行文本里就含这段字符串），结果是 exit code 143、什么都没干成。
# 这里改成按端口找 pid。
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
LOG="${LOG:-/tmp/artworks-server.log}"

pid_of() {
  ss -ltnp 2>/dev/null | grep ":${PORT}\b" | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

case "${1:-status}" in
  start)
    p="$(pid_of)"
    if [ -n "$p" ]; then echo "已经在跑：pid $p"; exit 0; fi
    setsid nohup node src/index.ts >"$LOG" 2>&1 &
    sleep 1
    echo "已启动（日志 $LOG）"
    ;;
  stop)
    p="$(pid_of)"
    if [ -n "$p" ]; then kill "$p"; echo "已停：pid $p"; else echo "没在跑"; fi
    ;;
  restart)
    "$0" stop >/dev/null; sleep 1; "$0" start
    ;;
  status)
    p="$(pid_of)"
    if [ -n "$p" ]; then echo "在跑：pid $p（端口 $PORT）"; else echo "没在跑（端口 $PORT）"; fi
    ;;
  log) tail -n "${2:-30}" "$LOG" ;;
  *) echo "用法：dev.sh start|stop|restart|status|log [行数]" >&2; exit 2 ;;
esac
