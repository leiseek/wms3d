#!/usr/bin/env bash
# M0a Docker 可行性 spike 复现脚本（结果见 docs/spikes/m0a-docker.md）。需要 sudo。
# 本机内核/容器环境无 iptables → 只能 --iptables=false --bridge=none；容器用 --network host/none。
set -euo pipefail
VER="${DOCKER_VERSION:-29.9.3}"
BIN=/opt/tools/docker
WORK="${WORK:-/tmp/wms3d-docker}"
mkdir -p "$WORK"
if [ ! -x "$BIN/dockerd" ]; then
  sudo mkdir -p "$BIN" && sudo chown "$(id -u):$(id -g)" "$BIN"
  curl -sSL "https://download.docker.com/linux/static/stable/x86_64/docker-$VER.tgz" | tar xz -C "$BIN" --strip-components=1
  curl -sSL -o "$BIN/docker-compose" https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64
  chmod +x "$BIN/docker-compose"
fi
SOCK="unix://$WORK/docker.sock"
sudo env PATH="$BIN:$PATH" dockerd --data-root "$WORK/root" --exec-root "$WORK/exec" -H "$SOCK" \
  --pidfile "$WORK/dockerd.pid" --iptables=false --ip6tables=false --bridge=none >"$WORK/dockerd.log" 2>&1 &
trap 'sudo kill "$(cat "$WORK/dockerd.pid")" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do [ -S "$WORK/docker.sock" ] && break; sleep 1; done
D=(sudo "$BIN/docker" -H "$SOCK")
"${D[@]}" version --format 'server {{.Server.Version}}'
"${D[@]}" run --rm --network none hello-world | grep -m1 "Hello from Docker"
"${D[@]}" run -d --name wms3d-pgspike --network host -e POSTGRES_PASSWORD=spike -e PGPORT=55999 postgres:17 >/dev/null
sleep 10
"${D[@]}" exec wms3d-pgspike pg_isready -p 55999
"${D[@]}" rm -f wms3d-pgspike >/dev/null
"$BIN/docker-compose" version
echo "SPIKE OK（仅 host/none 网络；bridge 网络不可用）"
