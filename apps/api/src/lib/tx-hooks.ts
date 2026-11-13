/** 测试钩子：仓位加锁后暂停，用于强制联合验收 #5 的两种交错（CR1 #19）。生产代码不得设置。 */
export type TxLockHook = (
  phase: 'inventory-locked' | 'publish-locked',
  locationIds: string[],
) => Promise<void>;

let hook: TxLockHook | null = null;

export function setTxLockHook(h: TxLockHook | null): void {
  hook = h;
}

export async function afterLocationsLocked(
  phase: 'inventory-locked' | 'publish-locked',
  locationIds: string[],
): Promise<void> {
  await hook?.(phase, locationIds);
}
