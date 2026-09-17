#!/bin/bash
# 研数 · 一键启动（macOS 双击即可）
#
# 做三件事：装依赖（缺了才装）→ 构建前端 → 起服务 → 打开浏览器。
# 关掉这个终端窗口就等于停服务。

cd "$(dirname "$0")" || exit 1

BOLD='\033[1m'; DIM='\033[2m'; CYAN='\033[36m'; RED='\033[31m'; NC='\033[0m'
say() { printf "${CYAN}▸${NC} %s\n" "$1"; }
die() { printf "${RED}✗ %s${NC}\n" "$1"; read -r -p "按回车关闭…"; exit 1; }

printf "\n${BOLD}研数 · 考研数学 AI 自学系统${NC}\n"
printf "${DIM}————————————————————————————————${NC}\n\n"

# 1. 依赖
if [ ! -d node_modules ]; then
  say "首次运行，安装依赖（大概要几分钟）…"
  npm install || die "依赖安装失败"
else
  say "依赖已就绪"
fi

# 2. 构建前端（服务端会托管 web/dist）
if [ ! -d web/dist ]; then
  say "构建前端…"
  npm run build || die "前端构建失败"
else
  say "前端已构建（改过代码想重新构建就删掉 web/dist 再启动）"
fi

# 3. 端口占用检查
PORT="${PORT:-5180}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 $PORT 已被占用。先关掉占用的进程，或者用 PORT=5181 ./启动.command"
fi

# 4. 起服务
say "启动服务…"
sleep 1
open "http://127.0.0.1:$PORT" 2>/dev/null

printf "\n${DIM}地址：${NC}http://127.0.0.1:%s\n" "$PORT"
printf "${DIM}数据库：${NC}server/data/app.db\n"
printf "${DIM}停止：${NC}按 Ctrl+C，或直接关掉这个窗口\n\n"

exec npm run start
