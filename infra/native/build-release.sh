#!/usr/bin/env bash
# 构建可部署的发布目录（08 §5.1）：
#   <out>/app/   精简的 pnpm workspace：根清单 + lockfile + apps/api + 其依赖的 workspace 包源码（TS，Node 24 原生剥离类型运行）
#                + 生产依赖（pnpm install --prod --frozen-lockfile；workspace 包为符号链接，不在 node_modules 实体目录内，
#                  因此 Node 的“node_modules 内不剥离类型”限制不触发；pnpm deploy 会把它们拷进 node_modules，故不用）
#   <out>/admin/ 管理后台静态资源（apps/admin vite build）
#   <out>/scripts/ 运维脚本（backup/restore/reconcile/golive-check）
#   <out>/VERSION.json
# 用法：build-release.sh <out> [--no-admin] [--online]   （缺省 --offline：使用本机 pnpm store）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?用法：build-release.sh <out>}"; shift
ADMIN=1; OFFLINE=--offline
for a in "$@"; do case "$a" in --no-admin) ADMIN=0;; --online) OFFLINE="";; *) echo "未知参数 $a" >&2; exit 2;; esac; done
[ -e "$OUT/app" ] && rm -rf "$OUT/app" "$OUT/admin" "$OUT/scripts"
mkdir -p "$OUT/app"

# apps/api 的 workspace 依赖闭包（读 package.json，避免写死）
mapfile -t PKGS < <(node -e '
const fs=require("fs"),path=require("path");const root=process.argv[1];
const byName={};for(const d of fs.readdirSync(root+"/packages")){const f=root+"/packages/"+d+"/package.json";if(fs.existsSync(f))byName[require(f).name]="packages/"+d;}
const seen=new Set(["apps/api"]);const q=["apps/api"];
while(q.length){const p=require(root+"/"+q.shift()+"/package.json");for(const n of Object.keys(p.dependencies||{})){const d=byName[n];if(d&&!seen.has(d)){seen.add(d);q.push(d);}}}
console.log([...seen].join("\n"));' "$ROOT")
echo "workspace 闭包：${PKGS[*]}"
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/tsconfig.base.json" "$OUT/app/"
printf 'packages:\n' > "$OUT/app/pnpm-workspace.yaml"
for p in "${PKGS[@]}"; do
  mkdir -p "$OUT/app/$p"
  (cd "$ROOT/$p" && tar --exclude=node_modules --exclude=dist --exclude='*.test.ts' --exclude='__tests__' -cf - .) | tar -xf - -C "$OUT/app/$p"
  printf "  - '%s'\n" "$p" >> "$OUT/app/pnpm-workspace.yaml"
done
grep -E '^(onlyBuiltDependencies|  - esbuild|autoInstallPeers|strictPeerDependencies)' "$ROOT/pnpm-workspace.yaml" >> "$OUT/app/pnpm-workspace.yaml" || true
# 精简 workspace 与完整 lockfile 的 importer 集合不同 → 不能 --frozen-lockfile；用 --prefer-offline + 完整 lockfile 作为版本来源（锁定版本不漂移，见下方校验）
(cd "$OUT/app" && CI=1 pnpm install --prod $OFFLINE --config.confirmModulesPurge=false --filter @wms3d/api... >/tmp/wms3d-release-install.log 2>&1) \
  || { tail -30 /tmp/wms3d-release-install.log >&2; exit 1; }
# 版本校验：发布目录里 api 的直接依赖版本必须与仓库 lockfile 解析出的一致
node -e '
const fs=require("fs");const [src,dst]=process.argv.slice(1);
const lock=fs.readFileSync(src+"/pnpm-lock.yaml","utf8");
const pkg=require(dst+"/apps/api/package.json");let bad=0;
for(const n of Object.keys(pkg.dependencies)){ if(n.startsWith("@wms3d/"))continue;
  const real=fs.realpathSync(dst+"/apps/api/node_modules/"+n);const v=require(real+"/package.json").version;
  if(!lock.includes(n+"@"+v)){console.error("版本漂移："+n+"@"+v);bad++;} }
process.exit(bad?1:0);' "$ROOT" "$OUT/app"
rm -rf "$OUT/app/node_modules/.cache"

if [ "$ADMIN" = 1 ]; then
  (cd "$ROOT" && pnpm --filter @wms3d/admin build >/tmp/wms3d-release-admin.log 2>&1) || { tail -30 /tmp/wms3d-release-admin.log >&2; exit 1; }
  mkdir -p "$OUT/admin" && cp -r "$ROOT/apps/admin/dist/." "$OUT/admin/"
fi
mkdir -p "$OUT/scripts"
cp "$ROOT"/scripts/{backup.sh,backup-lib.sh,restore.sh,reconcile.sql,ws-config.sh,golive-check.sh} "$OUT/scripts/" 2>/dev/null || true
cat > "$OUT/VERSION.json" <<JSON
{"commit":"$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)","builtAt":"$(date -u +%FT%TZ)","node":"$(node -v)","packages":$(printf '%s\n' "${PKGS[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')}
JSON
echo "发布目录：$OUT（app $(du -sh "$OUT/app" | cut -f1)$( [ "$ADMIN" = 1 ] && echo "，admin $(du -sh "$OUT/admin" | cut -f1)")）"
