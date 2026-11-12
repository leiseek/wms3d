import { describe, expect, it, vi } from 'vitest';
import type { LayoutDoc, LayoutVersion } from '@wms3d/contracts';
import { createApiClient } from '@wms3d/api-client';
import { createMockApi, type MockApi } from '@wms3d/api-client/mock';
import { DEFAULT_PATTERN, demo, validateLayout } from '@wms3d/domain';
import {
  goldenLayout,
  goldenType,
} from '../../../../../../packages/domain/src/__fixtures__/golden-input.ts';
import {
  arrayCopy,
  compactRange,
  emptyDoc,
  ensureRackType,
  patchZone,
  placeRack,
  rackCodePreview,
  rotateRack,
} from './ops';
import { snapRack } from './snap';
import { createDesignerStore, HISTORY_LIMIT } from './history';
import { DraftSync, docDelta, type SaveState } from './draftSync';
import { describePublishError, isPreconditionFailed, layoutApi } from './layoutApi';

const zoneA: LayoutDoc['zones'][number] = {
  code: 'A',
  kind: 'STORAGE',
  polygon: [
    [0, 0],
    [60, 0],
    [60, 40],
    [0, 40],
  ],
};
const withZone = (): LayoutDoc => ({ ...emptyDoc(), zones: [zoneA] });

describe('ops', () => {
  it('placeRack：模板按值快照、自动 aisle/bayStart', () => {
    const { doc, key } = placeRack(withZone(), { type: goldenType, x: 2, z: 5 });
    expect(doc.rackTypes).toEqual([goldenType]);
    expect(doc.racks.find((r) => r.key === key)).toMatchObject({
      zone: 'A',
      aisle: 1,
      bayStart: 1,
      rackNo: 1,
    });
    const b = placeRack(doc, { type: goldenType, x: 13.2, z: 5 });
    expect(b.doc.rackTypes).toHaveLength(1);
    expect(b.doc.racks.find((r) => r.key === b.key)).toMatchObject({
      aisle: 1,
      bayStart: 9,
      rackNo: 2,
    });
    const c = placeRack(b.doc, { type: goldenType, x: 13.2, z: 8, rotationDeg: 180 });
    expect(c.doc.racks.find((r) => r.key === c.key)).toMatchObject({
      aisle: 1,
      bayStart: 2,
      rackNo: 1,
    });
  });
  it('ensureRackType：同 key 不同参数另存', () => {
    const d = ensureRackType(withZone(), goldenType).doc;
    const r = ensureRackType(d, { ...goldenType, levels: 2, levelHeightsM: [1, 1] });
    expect(r.key).toBe('g-4x3-2');
  });
  it('rotateRack：绕中心 90° 步进，侧别变化时修正 bayStart 奇偶，四次回到原位', () => {
    const placed = placeRack(withZone(), { type: goldenType, x: 10, z: 10 });
    let doc = placed.doc;
    const key = placed.key;
    const start = doc.racks[0]!;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      doc = rotateRack(doc, key);
      const r = doc.racks[0]!;
      seen.push(r.rotationDeg);
      expect(r.bayStart % 2).toBe(r.rotationDeg === 0 || r.rotationDeg === 90 ? 1 : 0);
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expect(doc.racks[0]!.x).toBeCloseTo(start.x, 6);
    expect(doc.racks[0]!.z).toBeCloseTo(start.z, 6);
  });
  it('rackCodePreview：货架码与仓位码范围', () => {
    const r = goldenLayout.racks.find((x) => x.key === 'hR1')!;
    const p = rackCodePreview(goldenLayout, r, DEFAULT_PATTERN);
    expect(p.rackCode).toBe('RA03-R01');
    expect(p.first).toBe('A03-02-A01');
    expect(p.last).toBe('A03-08-C02');
    expect(p.range).toBe('A03-02-A01…08-C02');
    expect(p.count).toBe(24);
    const bad = rackCodePreview(goldenLayout, { ...r, bayStart: 98 }, DEFAULT_PATTERN);
    expect(bad.error).toMatch(/超出/);
  });
  it('compactRange', () => {
    expect(compactRange('A03-01-A01', 'A03-07-D02')).toBe('A03-01-A01…07-D02');
    expect(compactRange('X', 'X')).toBe('X');
  });
  it('arrayCopy 生成 200+ 仓位且校验通过', () => {
    const p0 = placeRack(withZone(), { type: goldenType, x: 1, z: 5 });
    let doc = arrayCopy(p0.doc, p0.key, 3).doc; // 4 × 24 = 96
    const r = placeRack(doc, { type: goldenType, x: 1 + 11.2, z: 8, rotationDeg: 180 });
    doc = arrayCopy(r.doc, r.key, 4).doc; // +5 × 24 = 120
    expect(
      validateLayout(doc, { pattern: DEFAULT_PATTERN, minAisleWidthM: 2.5 }).filter(
        (i) => i.severity === 'ERROR',
      ),
    ).toEqual([]);
  });
  it('patchZone 改 code 同步货架引用', () => {
    const d = patchZone(goldenLayout, 'A', { code: 'C' });
    expect(d.racks.filter((r) => r.zone === 'C')).toHaveLength(4);
  });
});

describe('snap', () => {
  const doc = { ...goldenLayout };
  const hL2 = doc.racks.find((r) => r.key === 'hL2')!;
  it('靠近邻近货架边缘吸附到首尾相接', () => {
    const s = snapRack(doc, hL2, 11.32, 5.04);
    expect(s.x).toBeCloseTo(11.2, 6);
    expect(s.guides.some((g) => g.axis === 'x')).toBe(true);
  });
  it('远离时吸附 0.1m 网格；disabled 不吸附', () => {
    const lone = { ...doc, racks: [hL2] };
    expect(snapRack(lone, hL2, 20.04, 20.06)).toMatchObject({ x: 20, z: 20.1 });
    expect(snapRack(lone, hL2, 20.04, 20.06, { disabled: true })).toMatchObject({
      x: 20.04,
      z: 20.06,
    });
  });
});

describe('history（撤销/重做）', () => {
  it('exec/undo/redo、无变化不入栈、上限 200', () => {
    const s = createDesignerStore(withZone());
    s.getState().exec('放置', (d) => placeRack(d, { type: goldenType, x: 1, z: 5 }).doc);
    s.getState().exec('noop', (d) => d);
    expect(s.getState().past).toHaveLength(1);
    s.getState().undo();
    expect(s.getState().doc.racks).toHaveLength(0);
    s.getState().redo();
    expect(s.getState().doc.racks).toHaveLength(1);
    for (let i = 0; i < 250; i++)
      s.getState().exec('move', (d) => ({
        ...d,
        racks: d.racks.map((r) => ({ ...r, x: r.x + 0.1 })),
      }));
    expect(s.getState().past).toHaveLength(HISTORY_LIMIT);
    expect(s.getState().future).toHaveLength(0);
  });
  it('撤销后选中被删除的货架时自动清空选择', () => {
    const s = createDesignerStore(withZone());
    s.getState().exec('放置', (d) => placeRack(d, { type: goldenType, x: 1, z: 5 }).doc, {
      kind: 'racks',
      keys: ['r1'],
    });
    s.getState().undo();
    expect(s.getState().selection).toEqual({ kind: 'none' });
  });
});

/** mock core → fetch，与 api-client 的 mock.test 同法 */
function mockFetch(api: MockApi): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const res = await api.handle({ method: init?.method ?? 'GET', url, headers, body });
    const payload =
      res.body.kind === 'json'
        ? JSON.stringify(res.body.value)
        : res.body.kind === 'text'
          ? res.body.value
          : null;
    return new Response(res.status === 204 || res.status === 304 ? null : payload, {
      status: res.status,
      headers: res.headers,
    });
  };
}
async function client(mock: MockApi, username = 'admin') {
  let token: string | null = null;
  const c = createApiClient({ getAccessToken: () => token, fetch: mockFetch(mock) });
  token = (
    await c.r.authLogin({
      body: {
        username,
        password: demo.DEMO_PASSWORD,
        deviceId: `dev-${username}-0001`,
        client: 'web',
      },
    })
  ).accessToken;
  return c;
}
const WH1 = demo.demoWarehouse.id;

describe('对 contract mock：草稿 / 自动保存 / 412 三方 / 发布', () => {
  it('创建草稿 → 空闲 2s 才自动保存 → 服务端校验', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const mock = createMockApi();
      const la = layoutApi(await client(mock), WH1);
      const wh = await la.warehouse();
      const draft = (await la.draft()) ?? (await la.createDraft(wh.publishedLayoutVersion));
      const states: SaveState['status'][] = [];
      const sync = new DraftSync(draft, {
        save: la.saveDraft,
        fetchDraft: () => la.get('draft'),
        isPreconditionFailed,
        onState: (s) => states.push(s.status),
      });
      const doc2 = arrayCopy(draft.doc, draft.doc.racks[0]!.key, 1, 0).doc;
      sync.touch(draft.doc); // 无变化 → 不保存
      sync.touch(doc2);
      await vi.advanceTimersByTimeAsync(1900);
      expect(states).not.toContain('saving');
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() => expect(states).toContain('saved'));
      expect(sync.rowVersion).toBe(draft.rowVersion + 1);
      const v = await la.validate();
      // 复制出的货架与相邻货架重叠/编号冲突 → 服务端（共享 domain）校验给出 RACK_OVERLAP
      expect(v.issues.map((i) => i.code)).toContain('RACK_OVERLAP');
      sync.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('412：他人先保存 → conflict 状态含三方差异；保留我的 → 覆盖成功', async () => {
    const mock = createMockApi();
    const a = layoutApi(await client(mock, 'admin'), WH1);
    const b = layoutApi(await client(mock, 'manager'), WH1);
    const wh = await a.warehouse();
    const draft = await a.createDraft(wh.publishedLayoutVersion);
    // B 改了一个库区名
    const theirs: LayoutDoc = {
      ...draft.doc,
      zones: draft.doc.zones.map((z, i) => (i === 0 ? { ...z, name: '他人修改' } : z)),
    };
    await b.saveDraft(theirs, draft.rowVersion);
    let last = { status: 'idle' } as SaveState;
    const sync = new DraftSync(draft, {
      save: a.saveDraft,
      fetchDraft: () => a.get('draft'),
      isPreconditionFailed,
      onState: (s) => (last = s),
      idleMs: 0,
    });
    const mine = { ...draft.doc, racks: draft.doc.racks.slice(1) };
    sync.touch(mine);
    expect(await sync.flush()).toBe(false);
    expect(last.status).toBe('conflict');
    if (last.status !== 'conflict') return;
    expect(last.conflict.mineDelta.racks.removed).toEqual([draft.doc.racks[0]!.key]);
    expect(last.conflict.serverDelta.zones.changed).toEqual([draft.doc.zones[0]!.code]);
    expect(last.conflict.overlapping).toEqual([]);
    expect(await sync.keepMine(last.conflict.server)).toBe(true);
    const now = await a.get('draft');
    expect(now.doc.racks).toHaveLength(draft.doc.racks.length - 1);
    sync.dispose();
  });

  it('删除 SHP-01 后发布 v2（mock 用例）并给出 diff；不合法草稿发布 → LAYOUT_INVALID 可读描述', async () => {
    const mock = createMockApi();
    const la = layoutApi(await client(mock), WH1);
    const wh = await la.warehouse();
    let d: LayoutVersion = await la.createDraft(wh.publishedLayoutVersion);
    // 先发布一个冲突草稿：复制第一个货架到原地 → 编码重复
    const r0 = d.doc.racks[0]!;
    d = await la.saveDraft(
      { ...d.doc, racks: [...d.doc.racks, { ...r0, key: 'dup1' }] },
      d.rowVersion,
    );
    const err = await la.publish(d.rowVersion, false).catch((e: unknown) => e);
    const view = describePublishError(err);
    expect(view.title).toMatch(/校验未通过/);
    expect(view.detail).toMatch(/编码冲突/);
    // 修正：去掉重复，删除 SHP-01
    d = await la.saveDraft(
      {
        ...d.doc,
        racks: d.doc.racks.filter((r) => r.key !== 'dup1'),
        floorAreas: d.doc.floorAreas.filter((f) => f.locationCode !== 'SHP-01'),
      },
      d.rowVersion,
    );
    const v = await la.validate();
    expect(v.diff.deactivated.map((x) => x.code)).toContain('SHP-01');
    const res = await la.publish(d.rowVersion, false);
    expect(res.layoutVersion).toBe((wh.publishedLayoutVersion ?? 0) + 1);
    expect(docDelta(d.doc, (await la.get('published')).doc).racks.changed).toEqual([]);
  });

  it('describePublishError：412 / 非 ApiError', () => {
    expect(describePublishError(new Error('x')).title).toBe('发布失败');
  });
});
