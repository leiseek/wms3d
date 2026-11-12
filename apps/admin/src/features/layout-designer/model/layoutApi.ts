import type { ApiClient } from '@wms3d/api-client';
import { ApiError } from '@wms3d/api-client';
import type { LayoutDoc, LayoutIssue, LayoutVersion } from '@wms3d/contracts';

/** 设计器用到的 layout / locations 端点的薄封装（只用 contract-v1 的 api-client，不自造请求）。 */
export function layoutApi(api: ApiClient, warehouseId: string) {
  const params = { id: warehouseId };
  return {
    warehouse: () => api.r.getWarehouse({ params }),
    rackTypes: () => api.r.listRackTypes({}),
    createRackType: (body: Parameters<ApiClient['r']['createRackType']>[0]['body']) =>
      api.r.createRackType({ body }),
    versions: () => api.r.listLayoutVersions({ params }),
    get: (version: 'draft' | 'published' | number) =>
      api.r.getLayout({ params, query: { version } }) as Promise<LayoutVersion>,
    /** 草稿不存在返回 null */
    draft: async (): Promise<LayoutVersion | null> => {
      try {
        return (await api.r.getLayout({ params, query: { version: 'draft' } })) as LayoutVersion;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    createDraft: (basedOnVersion: number | null) =>
      api.r.createDraft({ params, body: { basedOnVersion } }),
    saveDraft: (doc: LayoutDoc, rowVersion: number) =>
      api.r.saveDraft({ params, body: { doc }, ifMatch: rowVersion }),
    deleteDraft: () => api.r.deleteDraft({ params }),
    validate: () => api.r.validateLayout({ params, body: {} }),
    publish: (rowVersion: number, confirmRecode: boolean) =>
      api.r.publishLayout({ params, body: { rowVersion, confirmRecode } }),
    locationsOfRack: (rack: string) => api.r.listLocations({ params, query: { rack, limit: 500 } }),
    bulkPatch: (ids: string[], patch: { isActive?: boolean; maxQty?: number | null }) =>
      api.r.bulkPatchLocations({ params, body: { ids, patch } }),
  };
}
export type LayoutApi = ReturnType<typeof layoutApi>;

export const isPreconditionFailed = (e: unknown) =>
  e instanceof ApiError && (e.status === 412 || e.code === 'PRECONDITION_FAILED');

/** 发布错误的人话描述（LAYOUT_INVALID / LAYOUT_HAS_STOCK / LAYOUT_RECODE_NEEDS_CONFIRM / 412 / 409）。 */
export interface PublishErrorView {
  title: string;
  detail: string;
  issues: LayoutIssue[];
  locations: Array<{ code: string; onHand: number }>;
}

export function describePublishError(e: unknown): PublishErrorView {
  if (!(e instanceof ApiError))
    return {
      title: '发布失败',
      detail: String((e as Error)?.message ?? e),
      issues: [],
      locations: [],
    };
  const ctx = (e.problem?.context ?? {}) as {
    issues?: LayoutIssue[];
    locations?: Array<{ code: string; onHand: number }>;
  };
  const base = { issues: ctx.issues ?? [], locations: ctx.locations ?? [] };
  switch (e.code) {
    case 'LAYOUT_INVALID': {
      const dup = base.issues.filter((i) => i.code === 'CODE_DUPLICATE').flatMap((i) => i.codes);
      return {
        ...base,
        title: '服务器校验未通过，未发布',
        detail: dup.length
          ? `编码冲突 ${dup.length} 个：${dup.slice(0, 8).join('、')}${dup.length > 8 ? '…' : ''}`
          : `共 ${base.issues.length} 个错误`,
      };
    }
    case 'LAYOUT_HAS_STOCK':
      return {
        ...base,
        title: '有库存的仓位将被删除/停用，未发布',
        detail: `请先移库或清点这些仓位：${base.locations
          .map((l) => `${l.code}（${l.onHand}）`)
          .slice(0, 8)
          .join('、')}`,
      };
    case 'LAYOUT_RECODE_NEEDS_CONFIRM':
      return { ...base, title: '有库存仓位将改码，需要确认', detail: e.message };
    case 'PRECONDITION_FAILED':
      return {
        ...base,
        title: '草稿已被他人修改',
        detail: '请先处理保存冲突（重新载入或保留我的）后再发布',
      };
    case 'CONFLICT':
      return { ...base, title: '发布冲突', detail: e.message };
    default:
      return { ...base, title: '发布失败', detail: e.message };
  }
}
