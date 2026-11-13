#!/usr/bin/env bash
# 生产依赖漏洞审计（M6 / 08）。允许信息级；high/critical 必须为 0。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# pnpm audit 在无漏洞时退出 0；有漏洞时非 0。先出 JSON 再判定级别。
out="$(mktemp)"
set +e
pnpm audit --prod --json >"$out" 2>/tmp/wms3d-audit-stderr
code=$?
set -e
if [ ! -s "$out" ]; then
  echo "pnpm audit 未输出 JSON：" >&2
  cat /tmp/wms3d-audit-stderr >&2
  exit 1
fi
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const advisories = j.advisories ?? j.metadata?.vulnerabilities ?? j.vulnerabilities ?? {};
let high = 0, crit = 0, low = 0, info = 0;
if (advisories && typeof advisories === "object" && !Array.isArray(advisories)) {
  if ("high" in advisories && typeof advisories.high === "number") {
    high = advisories.high; crit = advisories.critical ?? 0;
    low = (advisories.low ?? 0) + (advisories.moderate ?? 0) + (advisories.info ?? 0);
  } else {
    for (const a of Object.values(advisories)) {
      const sev = (a && a.severity) || "";
      if (sev === "critical") crit++;
      else if (sev === "high") high++;
      else low++;
    }
  }
}
console.log(`依赖审计：critical=${crit} high=${high} 其他=${low}`);
if (crit + high > 0) process.exit(2);
' "$out"
rm -f "$out"
# pnpm audit 因低危非 0 时，只要无 high/critical 仍视为通过
exit 0
