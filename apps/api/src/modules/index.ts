/** 模块清单（Lead 所有）。新增模块须走契约变更；各 WS 只改自己模块目录。 */
import { opsModule } from './ops/index.ts';
import { authModule } from './auth/index.ts';
import { usersModule } from './users/index.ts';
import { warehousesModule } from './warehouses/index.ts';
import { layoutModule } from './layout/index.ts';
import { locationsModule } from './locations/index.ts';
import { skusModule } from './skus/index.ts';
import { scanModule } from './scan/index.ts';
import { labelsModule } from './labels/index.ts';
import { inventoryModule } from './inventory/index.ts';
import { countsModule } from './counts/index.ts';
import { syncModule } from './sync/index.ts';
import { twinModule } from './twin/index.ts';
import { eventsModule } from './events/index.ts';
import { auditModule } from './audit/index.ts';
import { dashboardModule } from './dashboard/index.ts';
import type { ApiModule } from './types.ts';

export const modules: ReadonlyArray<readonly [name: string, module: ApiModule]> = [
  ['ops', opsModule], // ws-a1
  ['auth', authModule], // ws-a1
  ['users', usersModule], // ws-a1
  ['warehouses', warehousesModule], // ws-a1
  ['layout', layoutModule], // ws-a1
  ['locations', locationsModule], // ws-a1
  ['skus', skusModule], // ws-a1
  ['scan', scanModule], // ws-a1
  ['labels', labelsModule], // ws-a1
  ['inventory', inventoryModule], // ws-a2
  ['counts', countsModule], // ws-a2
  ['sync', syncModule], // ws-a2
  ['twin', twinModule], // ws-a2
  ['events', eventsModule], // ws-a2
  ['audit', auditModule], // ws-a2
  ['dashboard', dashboardModule], // ws-a2
];
