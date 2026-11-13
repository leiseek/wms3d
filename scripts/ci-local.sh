#!/usr/bin/env bash
# 本地 CI（09 §6；ws-f 简报 §1）。GitHub 接入后同一组步骤搬进 workflow。
# 用法：ci-local.sh [--quick | --full] [--apk] [--no-e2e] [--no-db] [--keep-going]
#   缺省：install → lint → typecheck(+e2e/scripts) → test（PG 在跑则含 DB 用例）→ build → check:ownership
#         → 脚本单测 → e2e(mock) → e2e(real，需 PG)
#   --quick  只跑 pnpm verify 等价步骤 + check:ownership
#   --full   另加：备份→恢复→对账演练、原生部署 --foreground 冒烟、prettier --check（= 建议的 `pnpm verify:full`）
#   --apk    另加 pnpm apk:debug（Gradle 全局 flock 串行）
# 结果：/workspace/wms3d-artifacts/ci/<UTC>-<ws>-<sha>/{summary.json,summary.md,<step>.log}；退出码 = 失败步骤数（0 = 全绿）
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=clean-env.sh
source "$DIR/clean-env.sh"
cd "$ROOT"

MODE=default; APK=0; E2E=1; DB=1; KEEP_GOING=0
for a in "$@"; do
  case "$a" in
    --quick) MODE=quick;; --full) MODE=full;; --apk) APK=1;; --no-e2e) E2E=0;; --no-db) DB=0;; --keep-going) KEEP_GOING=1;;
    -h|--help) sed -n '2,10p' "$0"; exit 0;;
    *) echo "未知参数：$a" >&2; exit 2;;
  esac
done
[ "$MODE" = full ] && KEEP_GOING=1
WS="${WMS_WS:-unknown}"
SHA="$(git rev-parse --short HEAD)"
DIRTY="$(git status --porcelain | grep -qv '^??' && echo true || echo false)"
OUT="/workspace/wms3d-artifacts/ci/$(date -u +%Y%m%dT%H%M%SZ)-$WS-$SHA"
mkdir -p "$OUT"
PG_UP=0
if [ "$DB" = 1 ] && bash scripts/dev-db.sh status >/dev/null 2>&1; then PG_UP=1; fi
[ "$PG_UP" = 1 ] || export WMS_SKIP_DB_TESTS=1

STEPS=(); RESULTS=(); FAILED=0; T_ALL=$(date +%s)
run() {
  local name="$1"; shift
  if [ "$FAILED" -gt 0 ] && [ "$KEEP_GOING" = 0 ]; then STEPS+=("$name"); RESULTS+=("skipped|0"); return; fi
  local t0 rc; t0=$(date +%s)
  printf '▶ %-22s' "$name"
  ( "$@" ) >"$OUT/$name.log" 2>&1; rc=$?
  local dt=$(( $(date +%s) - t0 ))
  if [ $rc = 0 ]; then echo "✔ ${dt}s"; RESULTS+=("pass|$dt"); else echo "✘ ${dt}s（日志 $OUT/$name.log）"; tail -15 "$OUT/$name.log" | sed 's/^/    /'; RESULTS+=("fail|$dt"); FAILED=$((FAILED+1)); fi
  STEPS+=("$name")
}
skip() { STEPS+=("$1"); RESULTS+=("skipped|0"); echo "· $(printf '%-22s' "$1")跳过（$2）"; }

run install pnpm install --frozen-lockfile --offline
run lint pnpm lint
run typecheck bash -c 'pnpm typecheck && pnpm exec tsc -p e2e/tsconfig.json && pnpm exec tsc -p scripts/tsconfig.json'
run test pnpm test
run build pnpm build
run ownership pnpm check:ownership
if [ "$MODE" != quick ]; then
  if [ "$PG_UP" = 1 ]; then
    run scripts-tests bash -c 'set -e; for t in scripts/tests/*.test.sh; do echo "## $t"; bash "$t"; done'
  else skip scripts-tests "PG 未运行"; fi
  if [ "$E2E" = 1 ]; then
    run e2e-mock bash scripts/e2e.sh mock --reporter=list
    if [ "$PG_UP" = 1 ]; then run e2e-real bash scripts/e2e.sh real --reporter=list; else skip e2e-real "PG 未运行"; fi
    run e2e-admin env CI=1 PORT_API=4091 PORT_ADMIN=4092 CHROME_PATH="${CHROME_PATH:-/opt/google/chrome/chrome}" pnpm exec playwright test -c apps/admin/e2e/playwright.config.ts --reporter=list
    run e2e-mobile-ui env WMS_E2E_PORT=4339 WMS_E2E_CHROME="${WMS_E2E_CHROME:-${CHROME_PATH:-/opt/google/chrome/chrome}}" pnpm exec playwright test -c apps/mobile/e2e/playwright.config.ts --reporter=list
  else skip e2e "--no-e2e"; fi
fi
if [ "$MODE" = full ]; then
  if [ "$E2E" = 1 ] && [ "$PG_UP" = 1 ]; then
    run e2e-m45 bash scripts/e2e.sh real --ui -- --project=ui-m45 --reporter=list
    run e2e-m5 bash scripts/e2e.sh real --ui -- --project=ui-m5 --reporter=list
  elif [ "$E2E" != 1 ]; then skip e2e-m45 "--no-e2e"; skip e2e-m5 "--no-e2e"
  else skip e2e-m45 "PG 未运行"; skip e2e-m5 "PG 未运行"; fi
  run format-check pnpm format:check
  if [ "$PG_UP" = 1 ]; then run backup-drill bash scripts/backup-drill.sh --db wms_lead --report-dir "$OUT"; else skip backup-drill "PG 未运行"; fi
  run native-smoke bash infra/native/install.sh --foreground --smoke
fi
if [ "$APK" = 1 ]; then run apk pnpm apk:debug; fi

# e2e 计数（Playwright list 输出末尾的 "N passed / N skipped / N failed"）
e2e_counts() { [ -f "$OUT/$1.log" ] && grep -Eo '[0-9]+ (passed|skipped|failed|flaky|did not run)' "$OUT/$1.log" | tr '\n' ',' | sed 's/,$//'; }
TOTAL=$(( $(date +%s) - T_ALL ))
node -e '
const [out, ws, sha, dirty, mode, total, pg, mockC, realC, ...rest] = process.argv.slice(1);
const half = rest.length / 2, steps = rest.slice(0, half), res = rest.slice(half);
const s = steps.map((n, i) => { const [status, sec] = res[i].split("|"); return { step: n, status, seconds: +sec }; });
const ok = s.every((x) => x.status !== "fail");
const j = { ws, commit: sha, dirtyTree: dirty === "true", mode, pgAvailable: pg === "1", verify: ok ? "green" : "red",
  totalSeconds: +total, steps: s, e2e: { mock: mockC || null, real: realC || null }, at: new Date().toISOString() };
require("fs").writeFileSync(out + "/summary.json", JSON.stringify(j, null, 2));
const md = [`# 本地 CI · ${ws} @ ${sha}（${mode}）`, "", `结果：**${j.verify}**，用时 ${total}s，PG ${j.pgAvailable ? "可用" : "不可用（DB 用例跳过）"}`, "",
  "| 步骤 | 结果 | 秒 |", "|---|---|---|", ...s.map((x) => `| ${x.step} | ${x.status} | ${x.seconds} |`), "",
  `e2e mock：${j.e2e.mock ?? "-"}；e2e real：${j.e2e.real ?? "-"}`].join("\n");
require("fs").writeFileSync(out + "/summary.md", md + "\n");
' "$OUT" "$WS" "$SHA" "$DIRTY" "$MODE" "$TOTAL" "$PG_UP" "$(e2e_counts e2e-mock)" "$(e2e_counts e2e-real)" "${STEPS[@]}" "${RESULTS[@]}"
ln -sfn "$OUT" "/workspace/wms3d-artifacts/ci/latest-$WS"
echo "CI $( [ $FAILED = 0 ] && echo 全绿 || echo "失败 $FAILED 步") · 用时 ${TOTAL}s · $OUT/summary.md"
exit "$FAILED"
