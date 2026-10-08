#!/usr/bin/env bash
# art-workspace 裸机安装脚本。
#
# 干的事（每一步都打印在干什么，重复跑是安全的）：
#   1) 检查系统依赖：node>=22、npm、ffmpeg、perl
#   2) npm ci 装 web / server 依赖
#   3) 构建前端（**必须带 VITE_API_BASE=/api/v1**，否则会把 mock 数据源打进产物）
#   4) 生成配置文件（已存在就跳过，不覆盖你手改的内容）
#   5) 装并 enable systemd 单元（能走用户级就走用户级，系统级需要 root）
#
# 用法：
#   deploy/install.sh                       # 交互式（首次生成配置时会问两个路径）
#   deploy/install.sh --no-service          # 只装依赖 + 构建，不碰 systemd
#   deploy/install.sh --config /path/cfg.yaml --data-dir /srv/artworks --photos ~/Pictures
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME=artworks
WITH_SERVICE=1
CONFIG_PATH=""
DATA_DIR=""
PHOTOS_DIR=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-service) WITH_SERVICE=0 ;;
    --config) CONFIG_PATH="${2:-}"; shift ;;
    --data-dir) DATA_DIR="${2:-}"; shift ;;
    --photos) PHOTOS_DIR="${2:-}"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m警告：%s\033[0m\n' "$*" >&2; }

# ── 1) 系统依赖 ────────────────────────────────────────────────────────────
step "检查系统依赖"
missing=0
for cmd in node npm ffmpeg perl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  [ok] $cmd -> $(command -v "$cmd")"
  else
    echo "  [缺失] $cmd"
    missing=1
  fi
done
[ "$missing" -eq 0 ] || {
  echo "缺依赖。Debian/Ubuntu：sudo apt-get install -y ffmpeg perl；Node 22+ 见 https://nodejs.org" >&2
  exit 1
}

NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node $NODE_MAJOR 太旧：后端直接跑 .ts，需要 Node >= 22。请升级。" >&2
  exit 1
fi
echo "  [ok] Node $(node -v)（>=22，可直接运行 TypeScript）"

# ── 2) 装依赖 ──────────────────────────────────────────────────────────────
step "安装依赖（npm ci，可复现）"
echo "  web/ ..."
(cd "$REPO/web" && npm ci)
echo "  server/ ..."
(cd "$REPO/server" && npm ci)

# ── 3) 构建前端 ────────────────────────────────────────────────────────────
step "构建前端（VITE_API_BASE=/api/v1）"
# 这个变量不加，产物会静默用 mock 数据源 —— 前端看起来能开，但永远读不到真实照片。
(cd "$REPO/web" && VITE_API_BASE=/api/v1 npm run build)
echo "  产物：$REPO/web/dist"

# ── 4) 配置文件 ────────────────────────────────────────────────────────────
# 默认落在 server/artworks.config.local.yaml（已 gitignore），不污染入库的默认配置。
if [ -z "$CONFIG_PATH" ]; then
  CONFIG_PATH="$REPO/server/artworks.config.local.yaml"
fi

if [ -f "$CONFIG_PATH" ]; then
  step "配置文件已存在，保持不变：$CONFIG_PATH"
else
  step "生成配置文件：$CONFIG_PATH"
  # 交互式才问路径；非交互（CI / 管道）用默认值或命令行参数
  if [ -z "$DATA_DIR" ]; then
    DATA_DIR="${HOME}/.local/share/artworks"
    if [ -t 0 ]; then read -rp "  数据目录 [$DATA_DIR]: " a && [ -n "${a:-}" ] && DATA_DIR="$a" || true; fi
  fi
  if [ -z "$PHOTOS_DIR" ]; then
    PHOTOS_DIR="${HOME}/Pictures"
    if [ -t 0 ]; then read -rp "  照片目录 [$PHOTOS_DIR]: " a && [ -n "${a:-}" ] && PHOTOS_DIR="$a" || true; fi
  fi
  [ -d "$PHOTOS_DIR" ] || warn "照片目录不存在：$PHOTOS_DIR（先把照片放进去，或之后在设置页添加项目）"
  mkdir -p "$DATA_DIR"
  cat >"$CONFIG_PATH" <<YAML
# 由 deploy/install.sh 生成的本机配置（已 gitignore）。
# 字段说明见 server/artworks.config.example.yaml。
host: 127.0.0.1
port: 8787
dataDir: $DATA_DIR
# 留空 = 免认证（只在本机开发时这样用）；对外访问请设密码并改 host: 0.0.0.0
password: ""
roots:
  - id: photos
    label: 照片库
    path: $PHOTOS_DIR
scan:
  maxDepth: 8
  rootTimeoutMs: 20000
logLevel: info
YAML
  echo "  已写入（photo root 指向 $PHOTOS_DIR）"
fi

# ── 5) systemd ─────────────────────────────────────────────────────────────
if [ "$WITH_SERVICE" -eq 0 ]; then
  step "跳过 systemd（--no-service）"
else
  step "安装 systemd 单元"
  render_unit() { # $1=目标路径 $2=WantedBy
    sed -e "s|@NODE@|$NODE_BIN|g" \
        -e "s|@REPO@|$REPO|g" \
        -e "s|@CONFIG@|$CONFIG_PATH|g" \
        -e "s|@USER@|$(id -un)|g" \
        -e "s|@WANTEDBY@|$2|g" \
        "$REPO/deploy/artworks.service" >"$1"
  }

  if [ "$(id -u)" -eq 0 ]; then
    # root：系统级。装完提醒把 User 改成非 root 的跑应用账号。
    install -d /etc/systemd/system
    render_unit "/etc/systemd/system/${SERVICE_NAME}.service" multi-user.target
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
    echo "  已装到 /etc/systemd/system/${SERVICE_NAME}.service 并启动"
    echo "  提示：单元里的 User=$(id -un) 是 root。想用别的账号跑，改完再 systemctl restart $SERVICE_NAME"
  else
    # 普通用户：用户级（无需 sudo）
    install -d "$HOME/.config/systemd/user"
    render_unit "$HOME/.config/systemd/user/${SERVICE_NAME}.service" default.target
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now "$SERVICE_NAME" 2>/dev/null; then
      echo "  已装到 ~/.config/systemd/user/${SERVICE_NAME}.service 并启动"
      echo "  查看状态：systemctl --user status $SERVICE_NAME"
      echo "  想注销后仍运行：loginctl enable-linger $USER"
    else
      warn "当前环境没有可用的 user systemd 会话（ssh/容器里常见）"
      echo "  单元已生成：$HOME/.config/systemd/user/${SERVICE_NAME}.service"
      echo "  登录桌面会话后再跑：systemctl --user daemon-reload && systemctl --user enable --now $SERVICE_NAME"
    fi
  fi
fi

step "完成"
cat <<EOF
配置：$CONFIG_PATH
前端产物：$REPO/web/dist
手动前台起：cd $REPO/server && ARTWORKS_CONFIG=$CONFIG_PATH node src/index.ts
EOF
