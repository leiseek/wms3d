#!/usr/bin/env bash
# 恢复/安装本机工具链到 /opt/tools（盒子重置后执行；幂等）。docs/dev-setup.md §1。
# 只从公开免费源下载：Maven Central（zonky PG 17.11 二进制）、Adoptium（JDK 21）、Google（Android cmdline-tools）。
# 用法：scripts/install-tools.sh [pg|jdk|android|all]（缺省 all）
set -euo pipefail
T=/opt/tools
WHAT="${1:-all}"
SUDO=""; [ -w /opt ] || SUDO="sudo -n"
$SUDO mkdir -p "$T" && $SUDO chown "$(id -u):$(id -g)" "$T"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

install_pg() {
  [ -x "$T/pg17/bin/pg_ctl" ] && { echo "pg17 已存在"; return; }
  local v=17.11.0 url="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/17.11.0/embedded-postgres-binaries-linux-amd64-17.11.0.jar"
  echo "下载 PostgreSQL $v（zonky）…"
  curl -fsSL -o "$TMP/pg.jar" "$url"
  (cd "$TMP" && unzip -q pg.jar '*.txz' && mkdir -p "$T/pg17" && tar -xJf ./*.txz -C "$T/pg17")
  "$T/pg17/bin/postgres" --version
}

install_jdk() {
  [ -x "$T/jdk21/bin/java" ] && { echo "jdk21 已存在"; return; }
  echo "下载 JDK 21（Adoptium Temurin）…"
  curl -fsSL -o "$TMP/jdk.tgz" "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p "$T/jdk21" && tar -xzf "$TMP/jdk.tgz" -C "$T/jdk21" --strip-components=1
  "$T/jdk21/bin/java" -version 2>&1 | head -1
}

install_android() {
  export JAVA_HOME="$T/jdk21" PATH="$T/jdk21/bin:$PATH"
  local sdk="$T/android-sdk"
  if [ ! -x "$sdk/cmdline-tools/latest/bin/sdkmanager" ]; then
    echo "下载 Android cmdline-tools…"
    curl -fsSL -o "$TMP/clt.zip" "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
    mkdir -p "$sdk/cmdline-tools" && (cd "$TMP" && unzip -q clt.zip) && rm -rf "$sdk/cmdline-tools/latest" && mv "$TMP/cmdline-tools" "$sdk/cmdline-tools/latest"
  fi
  yes | "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" --licenses >/dev/null || true
  "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" "platform-tools" "platforms;android-36" "build-tools;36.0.0" >/dev/null
  echo "Android SDK：$sdk"
}

write_env() {
  cat > "$T/env.sh" <<ENV
# 由 scripts/install-tools.sh 生成
export JAVA_HOME=$T/jdk21
export ANDROID_HOME=$T/android-sdk
export ANDROID_SDK_ROOT=$T/android-sdk
export WMS_PG_BIN=$T/pg17/bin
export PATH=$T/jdk21/bin:$T/android-sdk/platform-tools:$T/pg17/bin:\$PATH
ENV
}

case "$WHAT" in
  pg) install_pg;;
  jdk) install_jdk;;
  android) install_jdk; install_android;;
  all) install_pg; install_jdk; install_android;;
  *) echo "用法：$0 [pg|jdk|android|all]" >&2; exit 2;;
esac
write_env
echo "完成：source $T/env.sh"
