#!/usr/bin/env bash
# 上线签字检查（08 §6 D37、08 §2、10 §M6）。任何 FAIL → 退出码 1，交付清单不能签字。
# 用法：golive-check.sh [--prefix /opt/wms3d] [--url https://wms.example.com] [--db wms3d]
# 检查：配置文件权限/生产模式/JWT 强度；异地备份已配置且最近 26h 内成功；本地备份新鲜；最近 35 天内有恢复演练报告；
#       API /ready 与契约版本；演示账号默认密码不可登录；（https 时）证书剩余有效期 ≥ 14 天；安全响应头。
set -uo pipefail
PREFIX=/opt/wms3d; URL=""; DB="${WMS_DB:-wms3d}"
while [ $# -gt 0 ]; do
  case "$1" in --prefix) PREFIX="$2"; shift 2;; --url) URL="$2"; shift 2;; --db) DB="$2"; shift 2;;
    -h|--help) sed -n '2,6p' "$0"; exit 0;; *) echo "未知参数 $1" >&2; exit 2;; esac
done
FAILS=0; WARNS=0
pass() { echo "PASS  $*"; }; fail() { echo "FAIL  $*"; FAILS=$((FAILS+1)); }; warn() { echo "WARN  $*"; WARNS=$((WARNS+1)); }
ENVF="$PREFIX/etc/.env"; BENV="$PREFIX/etc/backup.env"
get() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2-; }

# 1. 配置
if [ -f "$ENVF" ]; then
  [ "$(stat -c %a "$ENVF")" = 600 ] && pass ".env 权限 600" || fail ".env 权限 $(stat -c %a "$ENVF")（应为 600）"
  [ "$(get "$ENVF" NODE_ENV)" = production ] && pass "NODE_ENV=production" || fail "NODE_ENV 不是 production"
  JS="$(get "$ENVF" JWT_SECRET)"
  [ "${#JS}" -ge 32 ] && pass "JWT_SECRET ≥ 32 字符" || fail "JWT_SECRET 过短或缺失"
else fail "缺少 $ENVF"; fi

# 2. 备份
REMOTE="$(get "$BENV" BACKUP_REMOTE)"
[ -n "$REMOTE" ] && pass "已配置异地备份 BACKUP_REMOTE" || fail "未配置 BACKUP_REMOTE（备份与数据同盘，D37 阻断项）"
export PGHOST="$(get "$BENV" PGHOST)" PGPORT="$(get "$BENV" PGPORT)" PGUSER="$(get "$BENV" PGUSER)"
PGHOST="${PGHOST:-/run/wms3d}"; PGPORT="${PGPORT:-5432}"; PGUSER="${PGUSER:-postgres}"
B="$(psql -qAtX -d "$DB" -c "SELECT COALESCE(EXTRACT(EPOCH FROM now() - (value->>'lastLocalAt')::timestamptz)::int, -1)||' '||COALESCE(EXTRACT(EPOCH FROM now() - (value->>'lastRemoteAt')::timestamptz)::int, -1)||' '||COALESCE(value->>'lastRemoteOk','false') FROM ops_status WHERE key='backup'" 2>/dev/null)"
read -r LOCAL_AGE REMOTE_AGE REMOTE_OK <<<"${B:--1 -1 false}"
{ [ "$LOCAL_AGE" -ge 0 ] && [ "$LOCAL_AGE" -le 93600 ]; } && pass "本地备份 $((LOCAL_AGE/3600))h 前" || fail "最近 26h 内没有本地备份（ops_status.backup）"
{ [ "$REMOTE_AGE" -ge 0 ] && [ "$REMOTE_AGE" -le 93600 ] && [ "$REMOTE_OK" = true ]; } && pass "异地备份 $((REMOTE_AGE/3600))h 前成功" || fail "最近 26h 内没有成功的异地备份"
DRILL="$(find "$PREFIX/logs" -maxdepth 1 -name 'restore-drill-*.json' -mtime -35 2>/dev/null | head -1)"
[ -n "$DRILL" ] && pass "35 天内有恢复演练报告（$(basename "$DRILL")）" || fail "35 天内没有恢复演练报告（scripts/restore.sh <dump> --report $PREFIX/logs/restore-drill-\$(date +%F).json）"

# 3. 服务
API_PORT="$(get "$ENVF" PORT_API)"; API_PORT="${API_PORT:-3000}"
R="$(curl -fsS -m 5 "http://127.0.0.1:$API_PORT/api/v1/ready" 2>/dev/null)" && pass "API /ready：$R" || fail "API /ready 不通"
H="$(curl -fsS -m 5 "http://127.0.0.1:$API_PORT/api/v1/health" 2>/dev/null)" && pass "契约版本 $(echo "$H" | grep -o '"contractVersion":"[^"]*"')" || fail "API /health 不通"
DEMO_OK=0
for u in admin manager op1 op2 viewer; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST "http://127.0.0.1:$API_PORT/api/v1/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$u\",\"password\":\"Wms3d#demo\",\"deviceId\":\"golive-check-0\",\"client\":\"mobile\"}")"
  [ "$code" = 200 ] && { fail "演示账号 $u 仍可用默认密码登录（P0：删除演示数据或改密）"; DEMO_OK=1; }
done
[ "$DEMO_OK" = 1 ] || pass "演示账号默认密码均不可登录"

# 4. 边缘（Caddy）
if [ -n "$URL" ]; then
  HD="$(curl -fsSI -m 5 "$URL/" 2>/dev/null)"
  echo "$HD" | grep -qi '^x-frame-options: DENY' && echo "$HD" | grep -qi '^content-security-policy:' && pass "安全响应头" || fail "缺少安全响应头"
  if [[ "$URL" == https://* ]]; then
    echo "$HD" | grep -qi '^strict-transport-security:' && pass "HSTS" || fail "缺少 HSTS"
    HOSTP="${URL#https://}"; HOSTP="${HOSTP%%/*}"
    END="$(echo | openssl s_client -connect "$HOSTP:443" -servername "${HOSTP%%:*}" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -n "$END" ]; then
      DAYS=$(( ($(date -d "$END" +%s) - $(date +%s)) / 86400 ))
      [ "$DAYS" -ge 14 ] && pass "证书剩余 $DAYS 天" || fail "证书剩余 $DAYS 天（< 14）"
    else warn "无法读取证书"; fi
  else warn "URL 不是 https（仅限内网测试）"; fi
else warn "未给 --url，跳过边缘检查"; fi

echo "—— golive-check：FAIL $FAILS · WARN $WARNS"
[ "$FAILS" = 0 ]
