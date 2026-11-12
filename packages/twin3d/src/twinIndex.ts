import type { TwinModel } from '@wms3d/contracts';

/** twinIndex = TwinModel.locations 数组下标，仅在该 layoutVersion 内有效（D16）。 */
export interface TwinIndex {
  layoutVersion: number;
  idToIndex: Map<string, number>;
  indexToId: readonly string[];
}

export function buildTwinIndex(model: TwinModel): TwinIndex {
  const ids = model.locations.id;
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idToIndex.set(ids[i]!, i);
  return { layoutVersion: model.layoutVersion, idToIndex, indexToId: ids };
}

/** locationId[] → 下标（忽略不在本版本中的 id）。 */
export function indicesOf(index: TwinIndex, ids: readonly string[]): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const i = index.idToIndex.get(id);
    if (i !== undefined) out.push(i);
  }
  return out;
}
