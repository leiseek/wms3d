#!/usr/bin/env node
// 检查当前分支相对 main 的改动是否都在本工作流的独占目录内（docs/10-dev-plan.md §1/§6.1）。
// 工作流取自环境变量 WMS_WS（wt.sh 写入 .env.local）；未设置或 lead 时跳过。
import { execSync } from 'node:child_process';

const OWNERS = {
  // v2.1（R2 N11）：apps/api/src/db/**（schema、迁移、locks.ts）在 M0b 冻结后归 Lead
  'ws-a1': [
    'apps/api/src/app.ts',
    'apps/api/src/app.test.ts',
    'apps/api/src/main.ts',
    'apps/api/src/plugins/',
    'apps/api/src/lib/',
    'packages/domain/src/scan/',
    'apps/api/src/modules/auth/',
    'apps/api/src/modules/users/',
    'apps/api/src/modules/devices/',
    'apps/api/src/modules/warehouses/',
    'apps/api/src/modules/layout/',
    'apps/api/src/modules/skus/',
    'apps/api/src/modules/labels/',
  ],
  'ws-a2': [
    'apps/api/src/modules/inventory/',
    'apps/api/src/modules/counts/',
    'apps/api/src/modules/sync/',
    'apps/api/src/modules/twin/',
    'apps/api/src/modules/events/',
    'apps/api/src/modules/audit/',
    'apps/api/src/modules/jobs/',
    'apps/api/src/modules/dashboard/',
    'packages/domain/src/inventory/',
  ],
  'ws-b': ['apps/admin/'],
  'ws-c': ['apps/mobile/', 'native/', 'packages/scanner/', 'packages/ui/'],
  'ws-d1': ['apps/admin/src/features/layout-designer/', 'packages/domain/src/layout/'],
  'ws-d2': ['packages/twin3d/'],
  'ws-e': ['packages/labels/'],
  'ws-f': ['infra/', 'scripts/', 'e2e/'],
};
// v2.1（R2 B-N9）：依赖变更（任何 package.json / lockfile）只能由 Lead 合并，WS 走契约请求通道；
// 契约请求文件任何 WS 可新增。
// 合并队列在 git 之外（/workspace/.wms3d-queue/），见 10 §6.5。
const SHARED_OK = ['docs/contract-requests/'];
const EXCLUDE = { 'ws-b': ['apps/admin/src/features/layout-designer/'] };

const ws = process.env.WMS_WS;
if (!ws || ws === 'lead') {
  console.log('check-ownership: 未设置 WMS_WS 或为 lead，跳过');
  process.exit(0);
}
const owned = OWNERS[ws];
if (!owned) {
  console.error(`check-ownership: 未知工作流 ${ws}`);
  process.exit(2);
}
const base = execSync('git merge-base HEAD main', { encoding: 'utf8' }).trim();
const files = execSync(`git diff --name-only ${base}...HEAD`, { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const bad = files.filter((f) => {
  if (f === 'pnpm-lock.yaml' || f.endsWith('/package.json') || f === 'package.json') return true;
  if (SHARED_OK.some((p) => f.startsWith(p))) return false;
  if ((EXCLUDE[ws] ?? []).some((p) => f.startsWith(p))) return true;
  return !owned.some((p) => f.startsWith(p));
});
if (bad.length) {
  console.error(`check-ownership: ${ws} 改动了非独占文件：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-ownership: ${ws} OK（${files.length} 个文件）`);
