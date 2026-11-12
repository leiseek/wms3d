#!/usr/bin/env bash
# 获取 Caddy 官方静态二进制（GitHub releases）并按官方 checksums 文件校验 SHA-512。只下载工具，不注册/连接任何服务。
# 用法：fetch-caddy.sh [<dest-dir>] [<version 如 2.11.9>]；输出二进制路径。缺省目标 /workspace/.cache/wms3d-tools（不写 /opt/tools）。
set -euo pipefail
DEST="${1:-/workspace/.cache/wms3d-tools}"; VER="${2:-${CADDY_VERSION:-2.11.9}}"
BIN="$DEST/caddy-$VER/caddy"
if [ -x "$BIN" ]; then echo "$BIN"; exit 0; fi
ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=amd64;; aarch64) ARCH=arm64;; *) echo "不支持的架构 $ARCH" >&2; exit 1;; esac
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/caddyserver/caddy/releases/download/v$VER"
TGZ="caddy_${VER}_linux_${ARCH}.tar.gz"
curl -fsSL -o "$TMP/$TGZ" "$BASE/$TGZ"
curl -fsSL -o "$TMP/sums.txt" "$BASE/caddy_${VER}_checksums.txt"
(cd "$TMP" && grep " $TGZ\$" sums.txt | sha512sum -c --quiet) || { echo "Caddy 校验失败" >&2; exit 1; }
mkdir -p "$DEST/caddy-$VER"
tar -xzf "$TMP/$TGZ" -C "$DEST/caddy-$VER" caddy
chmod 755 "$BIN"
echo "$BIN"
