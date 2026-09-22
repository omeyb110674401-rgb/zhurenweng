#!/usr/bin/env bash
# 交互式把 QQ 邮箱的 SMTP 凭据写进生产 .env —— 请**操作者本人**在服务器终端里跑：
#
#   workbench connect -i <实例ID>       # 或任意 SSH / 云 Workbench 网页终端
#   cd /opt/zhurenweng && bash deploy/enter-smtp-credentials.sh
#
# 为什么要有这个脚本而不是把凭据发给助手代填：授权码只要出现在命令行里，就会同时落进
# shell history、阿里云助手的命令记录（控制台可查明文）和会话日志。这里用 `read -s`
# 从终端读，不回显、不入 history，值只经 stdin 交给 set-env-keys.sh。
#
# 端口固定 465 + 隐式 TLS：国内云主机一律封着 25 端口出站（本机已实测 smtp.qq.com:25
# 超时、:465 TLS 握手 102ms 通过）。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)

read -rp "QQ 邮箱地址（发件人，如 someone@qq.com）: " addr
read -rsp "SMTP 授权码（邮箱设置→POP3/IMAP/SMTP 里生成，不是网页登录密码）: " pass
echo
read -rp "任务失败告警收件邮箱（留空 = 用上面同一个地址）: " alert
addr=${addr//[[:space:]]/}
alert=${alert//[[:space:]]/}
[ -n "$addr" ] || { echo "邮箱地址不能为空" >&2; exit 1; }
[ -n "$pass" ] || { echo "授权码不能为空" >&2; exit 1; }
case "$addr" in *@*) ;; *) echo "邮箱地址缺少 @：$addr" >&2; exit 1 ;; esac
if printf '%s' "$pass" | grep -q '[$]'; then
  echo "授权码含 \$，compose 会把它当变量引用展开，请重新生成一个" >&2
  exit 1
fi

# MAIL_FROM 与 SMTP_USER 同值：QQ 的 SMTP 会拒收「发件人 ≠ 认证账户」的信。
# 想加中文显示名（如 主人翁 <x@qq.com>）等这条链路验通之后再改，先按最小可用配置走。
{
  printf 'SMTP_HOST=smtp.qq.com\n'
  printf 'SMTP_PORT=465\n'
  printf 'SMTP_SECURE=\n'
  printf 'SMTP_USER=%s\n' "$addr"
  printf 'SMTP_PASS=%s\n' "$pass"
  printf 'MAIL_FROM=%s\n' "$addr"
  printf 'ALERT_EMAIL=%s\n' "${alert:-$addr}"
} | bash "$here/set-env-keys.sh" -

echo
echo "下一步：先在 worker 容器里验一次真实发信（不碰 web，界面入口仍隐藏），命令见 docs/deploy.md 第 3 节。"
