#!/bin/bash
# 服务器端一键更新：git 拉取最新代码 + 重启后端
# 用法（在服务器上执行）：bash /opt/petcare/backend/deploy/pull-deploy.sh
set -e

APP_DIR=/opt/petcare
SERVICE=petcare

cd "$APP_DIR"

echo "=== 更新前版本 ==="
git log --oneline -1

echo "=== 拉取最新代码 ==="
git pull --ff-only

echo "=== 更新后版本 ==="
git log --oneline -1

# requirements.txt 有变化才装依赖（避免每次 pull 都跑 pip）
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^backend/requirements.txt$'; then
  echo "=== requirements.txt 有变化，安装依赖 ==="
  backend/.venv/bin/pip install -r backend/requirements.txt -q
fi

echo "=== 重启 $SERVICE ==="
systemctl restart "$SERVICE"
sleep 3
echo -n "服务状态: "
systemctl is-active "$SERVICE"
echo -n "接口探活: "
wget -qO- -T 5 http://127.0.0.1:8001/api/ping
echo
