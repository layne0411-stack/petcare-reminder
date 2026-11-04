#!/usr/bin/env bash
# 崽崽打卡站 —— 备案通过后的一键 HTTPS 部署脚本（OpenCloudOS / CentOS 系）
# 用法：把腾讯云下载的证书传到服务器后执行本脚本
#   bash setup-https.sh /root/downloads/zaizaidaka.site_bundle.crt /root/downloads/zaizaidaka.site.key
set -euo pipefail

CRT_SRC="${1:?用法: setup-https.sh <bundle.crt 路径> <key 路径>}"
KEY_SRC="${2:?用法: setup-https.sh <bundle.crt 路径> <key 路径>}"
CONF_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-zaizaidaka.conf"

DOMAIN=zaizaidaka.site
SSL_DIR=/etc/nginx/ssl

echo "==> 1/5 安装 nginx（已装则跳过）"
if ! command -v nginx >/dev/null 2>&1; then
  dnf install -y nginx
  systemctl enable --now nginx
fi

echo "==> 2/5 校验证书文件"
[ -f "$CRT_SRC" ] || { echo "找不到证书: $CRT_SRC"; exit 1; }
[ -f "$KEY_SRC" ] || { echo "找不到私钥: $KEY_SRC"; exit 1; }
openssl x509 -in "$CRT_SRC" -noout -subject -enddate

echo "==> 3/5 安装证书与站点配置"
mkdir -p "$SSL_DIR"
install -m 600 "$CRT_SRC" "$SSL_DIR/${DOMAIN}_bundle.crt"
install -m 600 "$KEY_SRC" "$SSL_DIR/${DOMAIN}.key"
install -m 644 "$CONF_SRC" /etc/nginx/conf.d/${DOMAIN}.conf

echo "==> 4/5 语法检查并重载"
nginx -t
systemctl reload nginx

echo "==> 5/5 放行 80/443（本机 firewalld，若未启用则跳过；腾讯云安全组需自行放行）"
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https
  firewall-cmd --reload
fi

echo
echo "✅ 完成。自检命令："
echo "   curl -I https://${DOMAIN}/api/ping"
echo "注意：请确认腾讯云安全组已放行 80 和 443 端口。"
