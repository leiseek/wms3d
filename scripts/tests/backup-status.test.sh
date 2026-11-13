#!/usr/bin/env bash
# backup.sh 集成：一次性克隆库上验证 ① 文件权限 600 + sha256 + 清单；② ops_status['backup'] 结构（看板契约）；
# ③ 异地拷贝成功（本地 rclone 替身）/ 失败（退出码 3，保留上次 lastRemoteAt）；④ GPG 加密备份可恢复。不连接任何外部服务。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export WMS_WS=ws-f
# shellcheck source=../backup-lib.sh
source "$DIR/backup-lib.sh"
DB="$(bash "$DIR/test-db.sh" clone ws-f | tail -1)"
T="$(mktemp -d)"; chmod 700 "$T"
cleanup() { bash "$DIR/test-db.sh" drop "$DB" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
fail=0; ok() { echo "ok $*"; }; bad() { echo "FAIL $*"; fail=1; }

# 本地 rclone 替身：rclone copy --no-traverse <src> <dst-dir>
cat > "$T/rclone-stub" <<'STUB'
#!/usr/bin/env bash
[ "$1" = copy ] || exit 2; mkdir -p "${@: -1}" && cp "${@: -2:1}" "${@: -1}/"
STUB
chmod +x "$T/rclone-stub"

F="$(BACKUP_REMOTE="$T/remote" BACKUP_RCLONE="$T/rclone-stub" "$DIR/backup.sh" --db "$DB" --dir "$T/b" 2>/dev/null | tail -1)"
[ "$(stat -c %a "$F")" = 600 ] && ok "备份文件权限 600" || bad "权限 $(stat -c %a "$F")"
(cd "$T/b" && sha256sum -c --quiet "$(basename "$F").sha256") && ok "sha256 旁文件" || bad "sha256"
[ -f "$T/remote/$(basename "$F")" ] && ok "异地拷贝（替身）" || bad "异地拷贝未落地"
V="$(q "$DB" "SELECT value FROM ops_status WHERE key='backup'")"
node -e 'const v=JSON.parse(process.argv[1]);process.exit(v.lastLocalAt&&v.lastRemoteAt&&v.remoteConfigured===true?0:1)' "$V" \
  && ok "ops_status 记录本地+异地时间" || bad "ops_status=$V"
FIRST_REMOTE="$(node -e 'console.log(JSON.parse(process.argv[1]).lastRemoteAt)' "$V")"

sleep 1
set +e; BACKUP_REMOTE="$T/remote" BACKUP_RCLONE=false "$DIR/backup.sh" --db "$DB" --dir "$T/b" >/dev/null 2>&1; RC=$?; set -e
[ "$RC" = 3 ] && ok "异地失败 → 退出码 3" || bad "异地失败退出码 $RC"
V2="$(q "$DB" "SELECT value FROM ops_status WHERE key='backup'")"
node -e 'const v=JSON.parse(process.argv[1]);process.exit(v.lastRemoteAt===process.argv[2]&&v.lastRemoteOk===false&&v.lastLocalAt>process.argv[2]?0:1)' "$V2" "$FIRST_REMOTE" \
  && ok "异地失败保留上次 lastRemoteAt" || bad "ops_status=$V2"

set +e; "$DIR/backup.sh" --db wms_ws_a1 --dir "$T/x" >/dev/null 2>&1; RC=$?; set -e
[ "$RC" != 0 ] && ok "护栏：拒绝备份其他 WS 的库" || bad "护栏失效"

# GPG：临时 keyring，不碰用户 ~/.gnupg
export GNUPGHOME="$T/gnupg"; mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-gen-key 'wms3d-drill <drill@localhost>' default default never 2>/dev/null
G="$(BACKUP_GPG_RECIPIENT=drill@localhost "$DIR/backup.sh" --db "$DB" --dir "$T/g" --no-status 2>/dev/null | tail -1)"
[[ "$G" == *.dump.gpg ]] && ! "$PG_RESTORE" -l "$G" >/dev/null 2>&1 && ok "GPG 加密（明文不可读）" || bad "GPG 文件 $G"
OUT="$("$DIR/restore.sh" "$G" 2>/dev/null | tail -1)" && ok "GPG 备份可恢复且对账通过" || bad "GPG 恢复：$OUT"
exit $fail
