/** 演示数据常量（与 packages/domain/src/demo 一致；e2e 不依赖内部包的运行时，只取确定性 id/编码）。 */
import { demo } from '../../packages/domain/src/index.ts';

export const WH1 = demo.demoWarehouse.id;
export const WH2 = demo.demoWarehouse2.id;
export const SKU1 = demo.demoSkus[0]!;
export const SKU2 = demo.demoSkus[1]!;
/** 选一个初始无货的存储仓位（与 demoBalances 互补，约 35% 货架仓位） */
const stocked = new Set(demo.demoBalances.map((b) => b.locationId));
export const EMPTY_LOCS = demo.demoLocations.filter((l) => l.rackKey && !stocked.has(l.id));
export const demoLayout = demo.demoLayout;
export const DEMO_LOCATION_COUNT = demo.demoLocations.length;
export { demo };
