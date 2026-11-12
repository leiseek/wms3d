import { expect, test, type Page } from '@playwright/test';
import type { LayoutDoc, LayoutRack } from '@wms3d/contracts';
import { rackFootprint } from '@wms3d/domain';
import golden from '../../../../../../packages/domain/src/__fixtures__/geometry-golden.json' with { type: 'json' };
import {
  goldenLayout,
  goldenType,
} from '../../../../../../packages/domain/src/__fixtures__/golden-input.ts';
import {
  clickWorld,
  fitView,
  getDoc,
  http,
  openDesigner,
  rackCorners,
  setDoc,
  SHOTS,
  toScreen,
  waitSaved,
} from './helpers';

const rackByCode = (doc: LayoutDoc, zone: string, aisle: number, rot: number, rackNo: number) =>
  doc.racks.find(
    (r) => r.zone === zone && r.aisle === aisle && r.rotationDeg === rot && r.rackNo === rackNo,
  )!;

async function selectRack(page: Page, doc: LayoutDoc, r: LayoutRack) {
  const t = doc.rackTypes.find((x) => x.key === r.type)!;
  const f = rackFootprint(r, t);
  const cx = (f[0][0] + f[2][0]) / 2;
  const cz = (f[0][1] + f[2][1]) / 2;
  await clickWorld(page, cx, cz);
  return [cx, cz] as const;
}

/** 点击放置（吸附 0.1m），再在属性面板里输入精确基点坐标（与真实操作一致：粗放 + 精调） */
async function placeAt(page: Page, x: number, z: number) {
  await clickWorld(page, x, z);
  for (const [id, v] of [
    ['rack-x', x],
    ['rack-z', z],
  ] as const) {
    const f = page.getByTestId(id);
    await f.fill(String(v));
    await f.press('Enter');
  }
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe.configure({ mode: 'serial' });

test('黄金样例在 2D 中的渲染与 geometry-golden.json 一致（Konva 变换后的四角坐标断言）', async ({
  page,
}) => {
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  await setDoc(page, goldenLayout);
  await fitView(page);
  for (const r of goldenLayout.racks) {
    const corners = await rackCorners(page, r.key);
    expect(corners, r.key).toEqual(rackFootprint(r, goldenType).map((p) => [p[0], p[1]]));
  }
  await page.screenshot({ path: `${SHOTS}/golden-2d.png` });
  // 四个旋转：同一模板、基点 (10,10)
  const rot: LayoutDoc = {
    ...goldenLayout,
    racks: golden.rotations.map((g, i) => ({
      key: `g${g.rotationDeg}`,
      zone: 'A',
      type: goldenType.key,
      aisle: 10 + i,
      rackNo: 1,
      bayStart: g.side === 'L' ? 1 : 2,
      x: 10,
      z: 10,
      rotationDeg: g.rotationDeg as 0 | 90 | 180 | 270,
    })),
  };
  await setDoc(page, rot);
  for (const g of golden.rotations)
    expect(await rackCorners(page, `g${g.rotationDeg}`)).toEqual(g.footprint);
});

test('脚本化设计 200+ 仓位（库区多边形 + 模板放置 + 阵列复制）并发布', async ({ page }) => {
  const started = Date.now();
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  // 仓库加宽到 100m，在右侧空地新建库区 C
  const width = page.getByTestId('doc-props').locator('input').first();
  await width.fill('100');
  await width.press('Enter');
  await fitView(page);
  await page.getByTestId('tools').getByText('库区多边形').click();
  for (const [x, z] of [
    [62, 2],
    [98, 2],
    [98, 38],
    [62, 38],
    [62, 2],
  ])
    await clickWorld(page, x!, z!);
  await expect(page.getByTestId('zone-props')).toContainText('库区 C');
  // 模板：重型托盘架（3 列 × 4 层 × 2 位 = 24 仓位/架，长 8.42m）
  await page.getByTestId('rack-type-select').click();
  await page.getByText('重型托盘架 2.7m×1.0m×4 层（', { exact: false }).click();
  await placeAt(page, 64, 6); // C01 左侧（rotation 0，取货面 z=6）
  await page.keyboard.press('r');
  await page.keyboard.press('r');
  await expect(page.getByTestId('place-rotation')).toContainText('180');
  await placeAt(page, 72.42, 9); // C01 右侧（rotation 180，取货面 z=9，巷道宽 3m）
  await page.keyboard.press('r');
  await page.keyboard.press('r');
  await placeAt(page, 64, 14); // C02 左侧
  await page.getByTestId('tools').getByText('选择').click();
  let doc = await getDoc(page);
  const c1l = rackByCode(doc, 'C', 1, 0, 1);
  const c1r = rackByCode(doc, 'C', 1, 180, 1);
  const c2l = rackByCode(doc, 'C', 2, 0, 1);
  expect([c1l.bayStart, c1r.bayStart, c2l.bayStart]).toEqual([1, 2, 1]);
  for (const [r, n] of [
    [c1l, 3],
    [c1r, 3],
    [c2l, 1],
  ] as const) {
    await selectRack(page, doc, r);
    const count = page.getByTestId('array-count');
    await count.fill(String(n));
    await count.press('Enter');
    await page.getByTestId('array-copy').click();
    doc = await getDoc(page);
  }
  expect(doc.racks.filter((r) => r.zone === 'C')).toHaveLength(10);
  await expect(page.getByTestId('error-count')).toHaveText('0');
  // 编码预览：选中 C01 右侧第 2 个货架
  await selectRack(page, doc, rackByCode(doc, 'C', 1, 180, 2));
  await expect(page.getByTestId('rack-code')).toHaveText('RC01-R02');
  await expect(page.getByTestId('code-range')).toHaveText('C01-08-A01…12-D02');
  await expect(page.getByTestId('cell-C01-12-D02')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/rack-layout-code-preview.png` });
  // 3D 预览分屏（twin3d v0 TwinView；无 GPU 时 SwiftShader 或自动 2D 降级）
  await page.getByTestId('toggle-3d').click();
  await expect(page.getByTestId('twin-preview').locator('canvas').first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/designer-3d-preview.png` });
  await page.getByTestId('toggle-3d').click();
  await waitSaved(page);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('diff-added')).toHaveText('240', { timeout: 20_000 });
  await expect(page.getByTestId('diff-deactivated')).toHaveText('0');
  await page.screenshot({ path: `${SHOTS}/publish-diff.png` });
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('publish-done')).toContainText('已发布 v');
  expect(Date.now() - started).toBeLessThan(30 * 60_000);
  await page.getByTestId('publish-close').click();
  await expect(page.getByTestId('no-draft')).toBeVisible();
});

test('实时校验：拖动货架造成重叠 → RACK_OVERLAP 标红；撤销恢复', async ({ page }) => {
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  const doc = await getDoc(page);
  const a = doc.racks.find((r) => r.key === 'a1l1')!;
  const b = doc.racks.find((r) => r.key === 'a1l2')!;
  const t = doc.rackTypes.find((x) => x.key === a.type)!;
  const [sx, sy] = await toScreen(page, a.x + 5, a.z - t.depthM / 2);
  const [tx, ty] = await toScreen(page, b.x + 2, b.z - t.depthM / 2 + 0.4);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('issue-RACK_OVERLAP').first()).toBeVisible();
  await expect(page.getByTestId('error-count')).not.toHaveText('0');
  await page.getByTestId('issue-RACK_OVERLAP').first().click();
  await page.mouse.move(tx, ty);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/validation-error-overlap.png` });
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('error-count')).toHaveText('0');
  await page.getByTestId('redo').click();
  await expect(page.getByTestId('error-count')).not.toHaveText('0');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('error-count')).toHaveText('0');
});

test('412 冲突：他人先保存 → 三方提示 → 保留我的', async ({ page }) => {
  const h = await http();
  const d = await h.freshDraft();
  await openDesigner(page);
  const other = await http('manager');
  const theirs = {
    ...d.doc,
    zones: d.doc.zones.map((z) => (z.code === 'A' ? { ...z, name: '他人改的名字' } : z)),
  };
  expect((await other.saveDraft(theirs, d.rowVersion)).status).toBe(200);
  const doc = await getDoc(page);
  await selectRack(
    page,
    doc,
    doc.racks.find((r) => r.key === 'b1l1')!,
  );
  await page.getByTestId('rotate').click();
  await expect(page.getByTestId('conflict-dialog')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('conflict-mine')).toContainText('货架 ~1');
  await expect(page.getByTestId('conflict-server')).toContainText('库区 ~1');
  await page.screenshot({ path: `${SHOTS}/conflict-412.png` });
  await page.getByTestId('conflict-keep-mine').click();
  await waitSaved(page);
  const server = await h.draft();
  expect(server.doc.racks.find((r) => r.key === 'b1l1')!.rotationDeg).toBe(180);
});

test('412 冲突：采用服务器 → 编辑器载入他人版本', async ({ page }) => {
  const h = await http();
  const d = await h.freshDraft();
  await openDesigner(page);
  const theirs = { ...d.doc, racks: d.doc.racks.filter((r) => r.key !== 'b1r2') };
  await (await http('manager')).saveDraft(theirs, d.rowVersion);
  const doc = await getDoc(page);
  await selectRack(
    page,
    doc,
    doc.racks.find((r) => r.key === 'b1l1')!,
  );
  await page.getByTestId('rotate').click();
  await page.getByTestId('conflict-adopt-server').click({ timeout: 15_000 });
  await expect(page.getByTestId('conflict-dialog')).toBeHidden();
  const now = await getDoc(page);
  expect(now.racks.some((r) => r.key === 'b1r2')).toBe(false);
  expect(now.racks.find((r) => r.key === 'b1l1')!.rotationDeg).toBe(90);
});

test('改码确认弹窗：有改码时必须勾选确认才能发布', async ({ page }) => {
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  // mock 的 validate 不计算改码（recoded 恒为空）；这里在网络层注入一条有库存的改码，验证 UI 交互
  await page.route('**/layout/validate', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.diff.recoded = [
      {
        locationId: '00000000-0000-7000-8000-000000000001',
        from: 'A01-01-A01',
        to: 'A01-03-A01',
        onHand: 5,
      },
      {
        locationId: '00000000-0000-7000-8000-000000000002',
        from: 'A01-01-A02',
        to: 'A01-03-A02',
        onHand: 0,
      },
    ];
    await route.fulfill({ response: res, json });
  });
  let confirmSent: boolean | null = null;
  await page.route('**/layout/publish', async (route) => {
    confirmSent = (route.request().postDataJSON() as { confirmRecode: boolean }).confirmRecode;
    await route.continue();
  });
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('recode-confirm-block')).toBeVisible();
  await expect(page.getByTestId('diff-recoded')).toHaveText('2');
  await expect(page.getByTestId('publish-confirm')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/recode-confirm.png` });
  await page.getByTestId('recode-confirm').check();
  await expect(page.getByTestId('publish-confirm')).toBeEnabled();
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('publish-done')).toBeVisible();
  expect(confirmSent).toBe(true);
});

test('发布错误：删除有库存货架被阻断；服务器端编码冲突（LAYOUT_INVALID）清楚列出冲突编码', async ({
  page,
}) => {
  const h = await http();
  await h.freshDraft();
  await openDesigner(page);
  let doc = await getDoc(page);
  await selectRack(
    page,
    doc,
    doc.racks.find((r) => r.key === 'a1l1')!,
  );
  await page.keyboard.press('Delete');
  await waitSaved(page);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('publish-dialog')).toContainText('有库存的仓位会被停用');
  await expect(page.getByTestId('publish-dialog')).toContainText('A01-01-A01');
  await expect(page.getByTestId('publish-confirm')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/publish-blocked-stock.png` });
  await page.getByTestId('publish-cancel').click();
  await page.keyboard.press('Control+z');
  // 制造编码冲突：b1r2 的 bayStart 改成与 b1r1 相同 → 本地即报 BAY_RANGE_OVERLAP / CODE_DUPLICATE
  doc = await getDoc(page);
  await selectRack(
    page,
    doc,
    doc.racks.find((r) => r.key === 'b1r2')!,
  );
  const bs = page.getByTestId('rack-baystart');
  await bs.fill('2');
  await bs.press('Enter');
  await expect(page.getByTestId('issue-CODE_DUPLICATE')).toBeVisible();
  await waitSaved(page);
  // 模拟"校验通过后、发布前被并发改坏"：validate 返回干净结果，publish 由 mock 权威校验拒绝
  await page.route('**/layout/validate', (route) =>
    route.fulfill({
      json: {
        issues: [],
        diff: { added: [], kept: 386, recoded: [], deactivated: [], reused: [] },
        locationCount: 386,
      },
    }),
  );
  await page.getByTestId('publish').click();
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('publish-error-title')).toHaveText('服务器校验未通过，未发布');
  await expect(page.getByTestId('publish-error-detail')).toContainText('编码冲突');
  await expect(page.getByTestId('publish-error-detail')).toContainText('B01-08-A01');
  await page.screenshot({ path: `${SHOTS}/publish-error-code-conflict.png` });
});
