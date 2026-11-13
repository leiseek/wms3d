#!/usr/bin/env bash
# wms3d 原生部署（08 §5.1，路径 A，本机已验证路径）：PostgreSQL 17 + API（Node 24）+ Caddy，systemd 托管。
#
#   sudo infra/native/install.sh --systemd [--prefix /opt/wms3d] [--domain wms.example.com] [--tls internal|acme|<crt>,<key>]
#        创建系统用户 wms3d、initdb、角色/库、写 unit、systemctl enable --now、健康检查。（本机无 systemd，未实机执行）
#   infra/native/install.sh --foreground [--smoke] [--keep] [--keep-running]
#        同一套步骤与模板，但用 pg_ctl / 后台 node / caddy run 托管在临时前缀（缺省 /tmp/wms3d-native-ws-f），
#        端口 API 4790 · PG 4791 · HTTP 4792（ws-f 段）。--smoke：健康检查 → 演示数据 → 登录 → 一笔入库 → 备份 → 恢复 → 对账；
#        另用 systemd-analyze verify 校验渲染出的 unit。结束停止全部进程并删除前缀（--keep 保留文件，--keep-running 不停进程）。
#   infra/native/install.sh --stop [--prefix P] [--keep]   停止 --keep-running 留下的前台实例
#
# 依赖：node ≥ 24、pnpm（构建发布目录）、PG17 服务端二进制（PG_BIN，缺省 /opt/tools/pg17/bin）、psql/pg_dump/pg_restore 17、
#       caddy（CADDY_BIN；缺省按 fetch-caddy.sh 的缓存路径查找，找不到则 --foreground 跳过 Caddy 并在报告中注明）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TPL="$HERE/templates"

MODE=""; SMOKE=0; KEEP=0; KEEP_RUNNING=0; DOMAIN=""; TLS="internal"; RELEASE=""; PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --systemd) MODE=systemd; shift;;
    --foreground) MODE=foreground; shift;;
    --smoke) SMOKE=1; shift;;
    --keep) KEEP=1; shift;;
    --keep-running) KEEP_RUNNING=1; KEEP=1; shift;;
    --stop) MODE=stop; shift;;
    --prefix) PREFIX="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --tls) TLS="$2"; shift 2;;
    --release) RELEASE="$2"; shift 2;;
    -h|--help) sed -n '2,14p' "$0"; exit 0;;
    *) echo "未知参数：$1" >&2; exit 2;;
  esac
done
[ -n "$MODE" ] || { echo "必须指定 --systemd 或 --foreground" >&2; exit 2; }
if [ "$MODE" = stop ]; then # 停止 --keep-running 留下的前台实例：install.sh --stop [--prefix P] [--keep]
  PREFIX="${PREFIX:-/tmp/wms3d-native-ws-f}"
  [ -f "$PREFIX/run/pids" ] && while read -r p; do kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true; done < "$PREFIX/run/pids"
  sleep 1
  PGB="${PG_BIN:-${WMS_PG_BIN:-/opt/tools/pg17/bin}}"
  [ -f "$PREFIX/data/pg/PG_VERSION" ] && "$PGB/pg_ctl" -D "$PREFIX/data/pg" -m fast -w stop >/dev/null 2>&1 || true
  [ "$KEEP" = 1 ] || rm -rf "$PREFIX"
  echo "已停止 $PREFIX"; exit 0
fi

log() { echo "[native $(date '+%T %Z')] $*" >&2; }
die() { echo "[native] 错误：$*" >&2; exit 1; }

if [ "$MODE" = foreground ]; then
  PREFIX="${PREFIX:-/tmp/wms3d-native-ws-f}"
  API_PORT="${API_PORT:-4790}"; PG_PORT="${PG_PORT:-4791}"; HTTP_PORT="${HTTP_PORT:-4792}"
  SOCK="$PREFIX/run"
else
  [ "$(id -u)" = 0 ] || die "--systemd 需要 root"
  command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "本机没有运行中的 systemd；请用 --foreground"
  PREFIX="${PREFIX:-/opt/wms3d}"
  API_PORT="${API_PORT:-3000}"; PG_PORT="${PG_PORT:-5432}"; HTTP_PORT="${HTTP_PORT:-443}"
  SOCK="/run/wms3d"
fi
DB="${WMS_DB:-wms3d}"
TZ_WH="${WMS_TIMEZONE:-Asia/Shanghai}"

# ---------- 依赖探测 ----------
NODE="${NODE_BIN:-$( [ -x "$PREFIX/node/bin/node" ] && echo "$PREFIX/node/bin/node" || command -v node )}"
[ -x "$NODE" ] || die "找不到 node"
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "需要 Node ≥ 24（$("$NODE" -v)）"
PG_BIN="${PG_BIN:-$( [ -x "$PREFIX/pg17/bin/postgres" ] && echo "$PREFIX/pg17/bin" || echo "${WMS_PG_BIN:-/opt/tools/pg17/bin}" )}"
[ -x "$PG_BIN/postgres" ] && [ -x "$PG_BIN/initdb" ] || die "找不到 PG17 服务端（PG_BIN=$PG_BIN）"
"$PG_BIN/postgres" --version | grep -q ' 17\.' || die "需要 PostgreSQL 17"
for t in psql pg_dump pg_restore; do
  p="$( [ -x "$PG_BIN/$t" ] && echo "$PG_BIN/$t" || command -v "$t" || true)"
  [ -n "$p" ] || die "找不到 $t（安装 postgresql-client-17）"
  "$p" --version | grep -q ' 17\.' || die "$t 必须是 17.x：$("$p" --version)"
done
PSQL="$( [ -x "$PG_BIN/psql" ] && echo "$PG_BIN/psql" || command -v psql)"
CADDY="${CADDY_BIN:-$(command -v caddy || ls -1 /workspace/.cache/wms3d-tools/caddy-*/caddy 2>/dev/null | sort -V | tail -1 || true)}"
if [ -z "$CADDY" ] || [ ! -x "$CADDY" ]; then
  [ "$MODE" = systemd ] && die "找不到 caddy（infra/native/fetch-caddy.sh 或 CADDY_BIN）"
  log "警告：找不到 caddy，前台冒烟将跳过 Caddy（报告中标注）"; CADDY=""
fi
log "模式 $MODE · 前缀 $PREFIX · node $("$NODE" -v) · PG $("$PG_BIN/postgres" --version | awk '{print $3}') · caddy ${CADDY:+$("$CADDY" version | awk '{print $1}')}"

render() { # render <tpl> <dst>
  sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@API_PORT@#$API_PORT#g" -e "s#@PG_PORT@#$PG_PORT#g" -e "s#@PG_BIN@#$PG_BIN#g" \
      -e "s#@NODE@#$NODE#g" -e "s#@NODE_DIR@#$(dirname "$NODE")#g" -e "s#@CADDY@#${CADDY:-/usr/local/bin/caddy}#g" \
      -e "s#@DB@#$DB#g" -e "s#@TZ@#$TZ_WH#g" -e "s#@SOCK@#$SOCK#g" "$1" > "$2"
}
rand_pw() { "$NODE" -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))'; }

# ---------- 目录与发布物 ----------
if [ "$MODE" = systemd ]; then
  id wms3d >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin wms3d
fi
mkdir -p "$PREFIX"/{etc,data,logs,backups,downloads,run,systemd,scripts}
chmod 700 "$PREFIX/etc" "$PREFIX/backups" "$PREFIX/data"
if [ -n "$RELEASE" ]; then
  log "使用发布目录 $RELEASE"; rm -rf "$PREFIX/app" "$PREFIX/admin"; cp -a "$RELEASE/app" "$PREFIX/app"; cp -a "$RELEASE/admin" "$PREFIX/admin"
  cp -a "$RELEASE/scripts/." "$PREFIX/scripts/"
else
  log "构建发布目录"; bash "$HERE/build-release.sh" "$PREFIX" >&2
fi
cp "$ROOT"/scripts/{backup.sh,backup-lib.sh,restore.sh,reconcile.sql,ws-config.sh,golive-check.sh} "$PREFIX/scripts/" 2>/dev/null || true
[ -f "$HERE/../RUNBOOK.md" ] && cp "$HERE/../RUNBOOK.md" "$PREFIX/RUNBOOK.md"

# ---------- 配置（首次生成，重装保留） ----------
if [ ! -f "$PREFIX/etc/.env" ]; then
  APP_PW="$(rand_pw)"; OWNER_PW="$(rand_pw)"; JWT="$("$NODE" -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  render "$TPL/env.tpl" "$PREFIX/etc/.env"
  sed -i -e "s#@APP_PW@#$APP_PW#" -e "s#@OWNER_PW@#$OWNER_PW#" -e "s#@JWT_SECRET@#$JWT#" "$PREFIX/etc/.env"
  [ "$MODE" = foreground ] && sed -i 's/^WMS_JOBS=1/WMS_JOBS=0/' "$PREFIX/etc/.env"
fi
chmod 600 "$PREFIX/etc/.env"
[ -f "$PREFIX/etc/backup.env" ] || render "$TPL/backup.env.tpl" "$PREFIX/etc/backup.env"
chmod 600 "$PREFIX/etc/backup.env"
envval() { grep -E "^$1=" "$PREFIX/etc/.env" | head -1 | cut -d= -f2-; }
APP_PW="$(envval DATABASE_URL | sed -E 's#^postgres://wms_app:([^@]+)@.*#\1#')"
OWNER_PW="$(envval MIGRATION_DATABASE_URL | sed -E 's#^postgres://wms_owner:([^@]+)@.*#\1#')"

# Caddyfile
if [ "$MODE" = foreground ]; then SITE="http://127.0.0.1:$HTTP_PORT"; TLSL=""; HSTS=""; GLOBAL="auto_https off"
else
  [ -n "$DOMAIN" ] || die "--systemd 需要 --domain"
  SITE="$DOMAIN"; HSTS='Strict-Transport-Security "max-age=31536000"'; GLOBAL=""
  case "$TLS" in
    internal) TLSL="tls internal";;             # 内部 CA：设备需安装根证书 + SPKI 校验（04 §1，08 §6.1）
    acme) TLSL="";;                              # ACME（DNS-01 需在 caddy.env 配置 DNS 提供商插件/凭据，见 RUNBOOK）
    *,*) TLSL="tls ${TLS%,*} ${TLS#*,}";;
    *) die "--tls 只能是 internal|acme|<crt>,<key>";;
  esac
fi
render "$TPL/Caddyfile.tpl" "$PREFIX/etc/Caddyfile"
sed -i -e "s#@SITE@#$SITE#" -e "s#@TLS@#$TLSL#" -e "s#@HSTS@#$HSTS#" -e "s#@GLOBAL@#$GLOBAL#" "$PREFIX/etc/Caddyfile"
if [ -n "$CADDY" ]; then
  "$CADDY" validate --config "$PREFIX/etc/Caddyfile" --adapter caddyfile >"$PREFIX/logs/caddy-validate.log" 2>&1 \
    || { cat "$PREFIX/logs/caddy-validate.log" >&2; die "Caddyfile 校验失败"; }
fi

# systemd 单元（两种模式都渲染；前台模式只用于 systemd-analyze verify）
for u in wms3d-pg.service wms3d-api.service wms3d-caddy.service wms3d-backup.service wms3d-backup.timer; do
  render "$TPL/$u" "$PREFIX/systemd/$u"
done

# ---------- PostgreSQL ----------
PGDATA="$PREFIX/data/pg"
as_svc() { if [ "$MODE" = systemd ]; then runuser -u wms3d -- "$@"; else "$@"; fi; }
[ "$MODE" = systemd ] && chown -R wms3d:wms3d "$PREFIX"/{data,logs,backups,run}
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  log "initdb $PGDATA（builtin C.UTF-8，与 code 列 COLLATE \"C\" 一致）"
  LOCAL_AUTH=trust; [ "$MODE" = systemd ] && LOCAL_AUTH=peer
  as_svc "$PG_BIN/initdb" -D "$PGDATA" -U postgres -E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 \
    --auth-local="$LOCAL_AUTH" --auth-host=scram-sha-256 >/dev/null
  cat >> "$PGDATA/postgresql.conf" <<CONF
# --- wms3d ---
listen_addresses = '127.0.0.1'
port = $PG_PORT
unix_socket_directories = '$SOCK'
max_connections = 100
shared_buffers = $( [ "$MODE" = systemd ] && echo 512MB || echo 64MB )
password_encryption = scram-sha-256
log_destination = 'stderr'
logging_collector = on
log_directory = '$PREFIX/logs'
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_min_duration_statement = 1000
CONF
  if [ "$MODE" = systemd ]; then
    # 本地 socket：OS 用户 wms3d / root 以 postgres 身份（peer + 映射），供备份与运维
    sed -i 's/^local\s\+all\s\+all\s\+peer$/local all postgres peer map=wms3d\nlocal all all peer/' "$PGDATA/pg_hba.conf"
    printf 'wms3d wms3d postgres\nwms3d root postgres\n' >> "$PGDATA/pg_ident.conf"
  fi
fi
FG_PIDS="$PREFIX/run/pids"
start_pg() {
  if [ "$MODE" = systemd ]; then systemctl daemon-reload; systemctl enable --now wms3d-pg.service
  else "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PREFIX/logs/pg-start.log" -w -t 60 start >/dev/null; fi
  for _ in $(seq 1 60); do "$PSQL" -h "$SOCK" -p "$PG_PORT" -U postgres -d postgres -qAtc 'select 1' >/dev/null 2>&1 && return 0; sleep 1; done
  die "PostgreSQL 未就绪"
}
if [ "$MODE" = systemd ]; then
  install -m 644 "$PREFIX"/systemd/* /etc/systemd/system/
fi
start_pg
PSQLA=("$PSQL" -h "$SOCK" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -qAtX)
log "角色与数据库（wms_owner 迁移/属主，wms_app 运行时，D11）"
"${PSQLA[@]}" -d postgres -v app_pw="$APP_PW" -v owner_pw="$OWNER_PW" -v db="$DB" <<'SQL'
SELECT format('CREATE ROLE wms_owner LOGIN PASSWORD %L', :'owner_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wms_owner') \gexec
SELECT format('CREATE ROLE wms_app LOGIN PASSWORD %L', :'app_pw') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wms_app') \gexec
SELECT format('ALTER ROLE wms_owner PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE wms_app PASSWORD %L', :'app_pw') \gexec
ALTER ROLE wms_app SET transaction_timeout = '30s';
ALTER ROLE wms_app SET idle_in_transaction_session_timeout = '30s';
SELECT format('CREATE DATABASE %I OWNER wms_owner', :'db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO wms_app', :'db') \gexec
SQL
"${PSQLA[@]}" -d "$DB" -c "ALTER SCHEMA public OWNER TO wms_owner; GRANT USAGE ON SCHEMA public TO wms_app; CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null 2>&1 || true

# ---------- API + Caddy ----------
fg_start() { # fg_start <name> <cmd...>
  local name="$1"; shift
  setsid "$@" >"$PREFIX/logs/$name.log" 2>&1 < /dev/null &
  echo "$!" >> "$FG_PIDS"; echo "$name $!" >> "$PREFIX/run/procs"
}
if [ "$MODE" = systemd ]; then
  systemctl enable --now wms3d-api.service wms3d-caddy.service wms3d-backup.timer
else
  : > "$FG_PIDS"; : > "$PREFIX/run/procs"
  ( cd "$PREFIX/app/apps/api" && set -a && . "$PREFIX/etc/.env" && set +a && unset WMS_WS PORT_ADMIN PORT_MOBILE && \
    fg_start api "$NODE" --experimental-strip-types src/main.ts )
  if [ -n "$CADDY" ]; then
    XDG_DATA_HOME="$PREFIX/data/caddy" XDG_CONFIG_HOME="$PREFIX/data/caddy" fg_start caddy "$CADDY" run --config "$PREFIX/etc/Caddyfile" --adapter caddyfile
  fi
fi

stop_all() {
  [ "$MODE" = foreground ] || return 0
  [ "$KEEP_RUNNING" = 1 ] && { log "--keep-running：进程保留（$PREFIX/run/procs）；停止：infra/native/install.sh --stop --prefix $PREFIX"; return 0; }
  if [ -f "$FG_PIDS" ]; then while read -r p; do kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true; done < "$FG_PIDS"; fi
  sleep 1
  "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  if [ "$KEEP" = 0 ]; then rm -rf "$PREFIX"; log "已删除 $PREFIX"; fi
}
[ "$MODE" = foreground ] && trap stop_all EXIT

# ---------- 健康检查 ----------
wait_http() { # wait_http <url> <秒>
  for _ in $(seq 1 "$2"); do curl -fsS -m 3 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}
API_URL="http://127.0.0.1:$API_PORT"
wait_http "$API_URL/api/v1/ready" 60 || { tail -30 "$PREFIX/logs/api.log" >&2 2>/dev/null; die "API /ready 未通过"; }
READY="$(curl -fsS "$API_URL/api/v1/ready")"; HEALTH="$(curl -fsS "$API_URL/api/v1/health")"
log "API 就绪：$READY · $HEALTH"
EDGE_URL=""
if [ -n "$CADDY" ]; then
  EDGE_URL="$( [ "$MODE" = foreground ] && echo "http://127.0.0.1:$HTTP_PORT" || echo "https://$DOMAIN")"
  wait_http "$EDGE_URL/api/v1/ready" 30 || { tail -30 "$PREFIX/logs/caddy.log" >&2 2>/dev/null; die "经 Caddy 的 /ready 未通过"; }
  log "Caddy 就绪：$EDGE_URL"
fi
[ "$SMOKE" = 1 ] || { log "安装完成"; exit 0; }

# ---------- 冒烟（09 §1 部署行）----------
REPORT_DIR="${REPORT_DIR:-/workspace/wms3d-artifacts/ci}"; mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/native-smoke-$(date -u +%Y%m%dT%H%M%SZ).json"
declare -A R=()
BASE="${EDGE_URL:-$API_URL}"
R[api_ready]=pass
R[contract]="$(echo "$HEALTH" | "$NODE" -pe 'JSON.parse(require("fs").readFileSync(0)).contractVersion')"
R[caddy]="$( [ -n "$CADDY" ] && echo pass || echo "skipped（无 caddy 二进制）")"
if [ -n "$CADDY" ]; then
  H="$(curl -fsSI "$EDGE_URL/")"
  echo "$H" | grep -qi '^x-frame-options: DENY' && echo "$H" | grep -qi '^content-security-policy:' && R[edge_headers]=pass || R[edge_headers]=fail
  curl -fsS "$EDGE_URL/" | grep -qi '<div id="root"' && R[admin_spa]=pass || R[admin_spa]=fail
  curl -fsS "$EDGE_URL/some/deep/route" | grep -qi '<div id="root"' && R[spa_fallback]=pass || R[spa_fallback]=fail
fi
log "写演示数据（主数据；生产环境不执行）"
(cd "$PREFIX/app/apps/api" && "$NODE" --experimental-strip-types src/db/seed-demo.ts "$(envval DATABASE_URL)" >&2) && R[seed]=pass || R[seed]=fail
LOGIN="$(curl -fsS -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"username":"manager","password":"Wms3d#demo","deviceId":"native-smoke-1","client":"mobile"}')" && R[login]=pass || R[login]=fail
TOKEN="$(echo "$LOGIN" | "$NODE" -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken' 2>/dev/null || true)"
USER_ID="$(echo "$LOGIN" | "$NODE" -pe 'JSON.parse(require("fs").readFileSync(0)).user.id' 2>/dev/null || true)"
WH1="$("${PSQLA[@]}" -d "$DB" -c "SELECT id FROM warehouses WHERE code='WH1'")"
LOC="$("${PSQLA[@]}" -d "$DB" -c "SELECT id FROM locations WHERE warehouse_id='$WH1' AND rack_id IS NOT NULL ORDER BY code LIMIT 1")"
SKU="$("${PSQLA[@]}" -d "$DB" -c "SELECT id FROM skus ORDER BY code LIMIT 1")"
TX_CODE="$(curl -s -o "$PREFIX/logs/txn.json" -w '%{http_code}' -X POST "$BASE/api/v1/inventory/transactions" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "idempotency-key: native-smoke-$(date +%s)" \
  -d "{\"type\":\"INBOUND\",\"warehouseId\":\"$WH1\",\"performedBy\":\"$USER_ID\",\"clientCreatedAt\":\"$(date -u +%FT%TZ)\",\"lines\":[{\"locationId\":\"$LOC\",\"skuId\":\"$SKU\",\"qty\":3}]}")"
case "$TX_CODE" in 201) R[txn]=pass;; 501) R[txn]="skipped（postTransaction 501，ws-a2 未合并）";; *) R[txn]="fail（HTTP $TX_CODE）";; esac
log "备份 → 恢复 → 对账（scripts/backup.sh / restore.sh，连接本前缀的 PG）"
export PGHOST="$SOCK" PGPORT="$PG_PORT" PGUSER=postgres
DUMP="$(env -u WMS_WS BACKUP_REMOTE= bash "$PREFIX/scripts/backup.sh" --db "$DB" --dir "$PREFIX/backups" | tail -1)" && R[backup]=pass || R[backup]=fail
REST="$(env -u WMS_WS bash "$PREFIX/scripts/restore.sh" "$DUMP" | tail -1)" && R[restore_reconcile]=pass || R[restore_reconcile]=fail
DASH_BACKUP="$("${PSQLA[@]}" -d "$DB" -c "SELECT value->>'lastLocalAt' FROM ops_status WHERE key='backup'")"
[ -n "$DASH_BACKUP" ] && R[ops_status_backup]=pass || R[ops_status_backup]=fail
if command -v systemd-analyze >/dev/null; then
  # 本机 PID 1 不是 systemd：用 --user 管理器做离线语法/指令校验（未知键、错误段落、ExecStart 路径等）；User= 在 user 模式下不校验
  XRT="$PREFIX/run/xdg"; mkdir -p "$XRT"; chmod 700 "$XRT"
  VERIFY="$(XDG_RUNTIME_DIR="$XRT" systemd-analyze --user --man=no --generators=no verify "$PREFIX"/systemd/*.service "$PREFIX"/systemd/*.timer 2>&1 || true)"
  [ -z "$VERIFY" ] && R[systemd_units]=pass || R[systemd_units]="fail：$(echo "$VERIFY" | tr '\n' ' ')"
fi
RES="$PREFIX/run/smoke-results.tsv"; : > "$RES"
for k in "${!R[@]}"; do printf '%s\t%s\n' "$k" "${R[$k]}" >> "$RES"; done
printf '%s' "$REST" > "$PREFIX/run/restore.json"
"$NODE" -e '
const fs = require("fs"); const [res, rest, out] = process.argv.slice(1);
const o = Object.fromEntries(fs.readFileSync(res, "utf8").trim().split("\n").map((l) => l.split("\t")));
let restore = null; try { restore = JSON.parse(fs.readFileSync(rest, "utf8")); } catch { /* 无 */ }
const fails = Object.entries(o).filter(([, v]) => String(v).startsWith("fail"));
fs.writeFileSync(out, JSON.stringify({ kind: "native-smoke", mode: "foreground", at: new Date().toISOString(), results: o, restore, pass: fails.length === 0 }, null, 2));
' "$RES" "$PREFIX/run/restore.json" "$REPORT"
cat "$REPORT"
"$NODE" -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).pass?0:1)' "$REPORT"
