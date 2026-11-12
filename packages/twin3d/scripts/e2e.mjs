// twin3d 浏览器端验收（Playwright + Chrome）：拾取、SKU 定位 ≤1s、实时更新（空↔有货/停用不重建）、层过滤、
// 布局版本绑定、上下文丢失重建、远景拾取货架、WebGL2 不可用自动 2D。
// 用法：node packages/twin3d/scripts/e2e.mjs [--no-build]
import assert from 'node:assert/strict';
import { BASE, VIEWPORTS, buildPlayground, launch, startPreview, waitTwin } from './pw-util.mjs';

if (!process.argv.includes('--no-build')) buildPlayground();
const stop = await startPreview();
const browser = await launch();
const results = [];
async function test(name, fn, ctxOpts = VIEWPORTS.desktop, init) {
  const ctx = await browser.newContext(ctxOpts);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const t = Date.now();
  try {
    await fn(page);
    assert.deepEqual(errors, [], '页面无 JS 错误');
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e) });
    console.log(`  ✗ ${name}\n    ${String(e).split('\n').join('\n    ')}`);
  } finally {
    await ctx.close();
  }
}
const open = async (page, q) => {
  await page.goto(`${BASE}?bench=1&${q}`);
  await waitTwin(page, 300);
};
const stats = (page) => page.evaluate(() => window.__twin.handle.stats());
const waitStats = async (page, pred, ms = 6000) => {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await stats(page);
    if (pred(s)) return s;
    await page.waitForTimeout(100);
  }
  return s;
};

try {
  await test('俯视点击顶层仓位 → onPick 返回该 locationId（解析式拾取）', async (page) => {
    await open(page, 'data=mock&preset=top');
    await page.waitForFunction(() => window.__twin.occ);
    const { id, pos } = await page.evaluate(() => {
      const m = window.__twin.model;
      const eng = window.__twin.handle.engine();
      const k = m.locations.code.findIndex(
        (_c, i) => m.locations.level[i] === 3 && m.locations.rackKey[i] === 'a2l1',
      );
      const id = m.locations.id[k];
      return { id, pos: eng.screenPosOf(id) };
    });
    const box = await page.locator('[data-twin-mode="3d"]').boundingBox();
    await page.mouse.click(box.x + pos.x, box.y + pos.y);
    await page.waitForTimeout(200);
    const picks = await page.evaluate(() => window.__twin.picks);
    assert.equal(picks.at(-1), id);
    await page.waitForSelector('[data-testid="twin-card"]');
    const card = await page.locator('[data-testid="twin-card"]').innerText();
    assert.match(card, /数量/);
  });

  await test('SKU 定位：高亮 + 光柱 + 飞行，提交到开始飞行 ≤ 1s', async (page) => {
    await open(page, 'data=mock&preset=iso');
    await page.waitForFunction(() => window.__twin.occ);
    await page.fill('[data-testid="locate-input"]', 'SKU-001');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__twin.locateMs !== null);
    const ms = await page.evaluate(() => window.__twin.locateMs);
    assert.ok(ms <= 1000, `locate→fly ${ms}ms`);
    const s = await waitStats(page, (x) => x.instances.highlight > 0);
    assert.ok(s.instances.highlight > 0);
  });

  await test('实时更新：入库（空→有货）、清空出库（有货→空）、停用；槽位切换不重建、计数守恒', async (page) => {
    await open(page, 'data=mock&preset=iso');
    await page.waitForFunction(() => window.__twin.occ);
    const s0 = await stats(page);
    const total = s0.instances.opaque + s0.instances.empty;
    const { code, id } = await page.evaluate(() => {
      const m = window.__twin.model;
      const o = window.__twin.occ;
      const k = o.qty.findIndex((q, i) => q === 0 && m.locations.rackKey[i]);
      return { code: m.locations.code[k], id: m.locations.id[k] };
    });
    const payload = `WH1.${code}`;
    await page.evaluate(() => (window.__geom = window.__twin.handle.engine().getSceneData()));
    await page.evaluate((p) => window.__twin.session.inbound(p, 50), payload);
    let s = await waitStats(page, (x) => x.instances.opaque === s0.instances.opaque + 1);
    assert.equal(s.instances.opaque, s0.instances.opaque + 1, '入库后不透明 +1');
    assert.equal(s.instances.empty, s0.instances.empty - 1, '入库后空 −1');
    assert.equal(s.instances.opaque + s.instances.empty, total);
    const sameGeom = await page.evaluate(
      () => window.__twin.handle.engine().getSceneData() === window.__geom,
    );
    assert.ok(sameGeom, '未重建场景数据');
    const info = await page.evaluate((i) => window.__twin.handle.engine().info(i), id);
    assert.equal(info.qty, 50);
    assert.equal(info.effectiveMax, 200, '容量来自 occupancy.effectiveMax');
    await page.evaluate((i) => window.__twin.session.outboundAll(i), id);
    s = await waitStats(page, (x) => x.instances.opaque === s0.instances.opaque);
    assert.equal(s.instances.empty, s0.instances.empty, '清空后回到空 mesh');
    await page.evaluate((i) => window.__twin.session.setActive(i, false), id);
    s = await waitStats(page, (x) => x.instances.opaque === s0.instances.opaque + 1);
    assert.equal(s.instances.opaque, s0.instances.opaque + 1, '停用仓位进不透明 mesh（暗红）');
    const off = await page.evaluate((i) => window.__twin.handle.engine().info(i), id);
    assert.equal(off.isActive, false);
  });

  await test('层过滤：只看第 1 层 → 可见实例 = 1 层仓位数（含地面）', async (page) => {
    await open(page, 'data=mock&preset=iso');
    await page.waitForFunction(() => window.__twin.occ);
    const expected = await page.evaluate(
      () => window.__twin.model.locations.level.filter((l) => l === null || l <= 1).length,
    );
    await page.evaluate(() => window.__twin.setMaxLevel(1));
    const s = await waitStats(page, (x) => x.instances.opaque + x.instances.empty === expected);
    assert.equal(s.instances.opaque + s.instances.empty, expected);
  });

  await test('布局版本绑定：新 layoutVersion 重建并按 locationId 重映射高亮；旧版本 occupancy 被拒并回调', async (page) => {
    await open(page, 'data=bench5k&preset=iso');
    const r = await page.evaluate(async () => {
      const w = window.__twin;
      const m = w.model;
      const ids = m.locations.id.slice(0, 3);
      w.setHighlight(ids);
      await new Promise((r) => setTimeout(r, 300));
      const before = w.handle.stats().instances.highlight;
      // 新版本：倒序排列仓位（twinIndex 全部改变）
      const n = m.locations.id.length;
      const rev = (a) => [...a].reverse();
      const m2 = {
        ...m,
        layoutVersion: m.layoutVersion + 1,
        locations: Object.fromEntries(Object.entries(m.locations).map(([k, v]) => [k, rev(v)])),
      };
      const oldOcc = w.occ;
      const staleBefore = w.staleCalls;
      w.setModel(m2);
      await new Promise((r) => setTimeout(r, 300));
      const eng = w.handle.engine();
      const hl = eng.getIndex();
      const mapped = ids.map((id) => hl.idToIndex.get(id));
      const after = w.handle.stats().instances.highlight;
      w.setOcc({ ...oldOcc });
      await new Promise((r) => setTimeout(r, 300));
      return {
        before,
        after,
        mapped,
        n,
        stale: w.staleCalls - staleBefore,
        v: eng.getModel().layoutVersion,
      };
    });
    assert.equal(r.before, 3);
    assert.equal(r.after, 3);
    assert.deepEqual(r.mapped, [r.n - 1, r.n - 2, r.n - 3]);
    assert.ok(r.stale >= 1, 'onStaleOccupancy 被回调（旧版本 occupancy 被拒）');
    assert.equal(r.v, 2);
  });

  await test('WebGL 上下文丢失 → 停止；恢复 → rebuild() 后实例一致', async (page) => {
    await open(page, 'data=mock&preset=iso');
    await page.waitForFunction(() => window.__twin.occ);
    const before = await stats(page);
    await page.evaluate(async () => {
      const ext = window.__twin.handle
        .engine()
        .renderer.getContext()
        .getExtension('WEBGL_lose_context');
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 300));
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 500));
    });
    const after = await stats(page);
    assert.deepEqual(after.instances, before.instances);
    assert.ok(after.calls > 0);
  });

  await test('20k 俯视（全部远景）：点击返回货架；draw calls ≤ 80', async (page) => {
    await open(page, 'data=bench20k&preset=top');
    const s = await stats(page);
    assert.equal(s.chunks.far, 40);
    assert.ok(s.calls <= 80);
    const box = await page.locator('[data-twin-mode="3d"]').boundingBox();
    const pos = await page.evaluate(() => {
      const m = window.__twin.model;
      return window.__twin.handle.engine().screenPosOf(m.locations.id[0]);
    });
    await page.mouse.click(box.x + pos.x, box.y + pos.y);
    await page.waitForTimeout(200);
    const picks = await page.evaluate(() => window.__twin.picks);
    assert.match(picks.at(-1) ?? '', /^rack:/);
  });

  await test(
    'WebGL2 不可用 → 自动 2D 平面图（同 props，定位高亮可用）',
    async (page) => {
      await page.goto(`${BASE}?data=mock&locate=SKU-001`);
      await page.waitForSelector('[data-twin-mode="2d"] canvas');
      await page.waitForFunction(() => window.__twin.mode === '2d');
    },
    VIEWPORTS.phone,
    () => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === 'webgl2') return null;
        return orig.call(this, type, ...rest);
      };
    },
  );

  await test(
    '启动基准：帧时间 p50 > 50ms → 先降 dpr，仍慢自动切 2D 并提示',
    async (page) => {
      await page.goto(`${BASE}?data=mock&preset=iso`);
      await page.waitForSelector('[data-testid="twin-fallback-banner"]', { timeout: 15_000 });
      const perf = await page.evaluate(() => window.__twin.perf);
      assert.equal(perf.length, 2);
      assert.equal(perf[0].degraded, true);
      assert.equal(perf[1].suggest2D, true);
      assert.equal(await page.evaluate(() => window.__twin.mode), '2d');
    },
    VIEWPORTS.desktop,
    () => {
      // 模拟慢设备：每帧 70ms
      window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 70);
    },
  );

  await test('2D 降级点击列 → onPick', async (page) => {
    await page.goto(`${BASE}?data=mock&force2d=1&ui=0`);
    await page.waitForSelector('[data-twin-mode="2d"] canvas');
    await page.waitForFunction(() => window.__twin.model);
    await page.waitForTimeout(300);
    // 用 2D 视图同样的适配变换求第一个仓位的屏幕位置：直接在画布上扫描，找到首个返回 onPick 的点
    const box = await page.locator('[data-twin-mode="2d"] canvas').boundingBox();
    let hit = false;
    for (let y = 0.1; y < 0.9 && !hit; y += 0.02)
      for (let x = 0.05; x < 0.6 && !hit; x += 0.02) {
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
        hit = (await page.evaluate(() => window.__twin.picks.length)) > 0;
      }
    assert.ok(hit, '2D 点击得到 onPick');
  });
} finally {
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\ne2e：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
