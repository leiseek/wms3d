#!/usr/bin/env bash
# 构建移动端 debug APK 并复制到 /workspace/wms3d-artifacts/（docs/dev-setup.md）。
# Gradle 构建全局串行（docs/10-dev-plan.md §6.4）：flock /tmp/wms3d-gradle.lock
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS="${WMS_ARTIFACTS_DIR:-/workspace/wms3d-artifacts}"
VARIANT="${1:-debug}"
[ -f /opt/tools/env.sh ] && source /opt/tools/env.sh
command -v java >/dev/null || { echo "需要 JDK 21（source /opt/tools/env.sh）" >&2; exit 1; }
: "${ANDROID_HOME:?需要 ANDROID_HOME}"

cd "$ROOT"
pnpm --filter @wms3d/mobile build
(cd apps/mobile && npx cap sync android)

cd apps/mobile/android
Task="assemble${VARIANT^}"
flock /tmp/wms3d-gradle.lock ./gradlew --no-daemon -q "$Task" "test${VARIANT^}UnitTest"

APK="app/build/outputs/apk/${VARIANT}/app-${VARIANT}.apk"
[ -f "$APK" ] || { echo "未找到 $APK" >&2; exit 1; }
mkdir -p "$ARTIFACTS"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
OUT="$ARTIFACTS/wms3d-${VARIANT}-${SHA}.apk"
cp "$APK" "$OUT"
cp "$APK" "$ARTIFACTS/wms3d-${VARIANT}-latest.apk"
cp "$APK" "$ARTIFACTS/wms3d-v0.1.0.apk"
echo "APK: $OUT ($(du -h "$OUT" | cut -f1))"
