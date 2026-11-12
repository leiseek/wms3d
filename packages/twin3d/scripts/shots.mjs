// 截图：总览 / 占用着色 / SKU 定位高亮 / 巷道视角 / 2D 降级 × 桌面 & 手机 → /workspace/wms3d-artifacts/screens/ws-d2/
import { mkdirSync } from 'node:fs';
import { BASE, VIEWPORTS, buildPlayground, launch, startPreview, waitTwin } from './pw-util.mjs';

const out = process.env.TWIN_SHOTS_DIR ?? '/workspace/wms3d-artifacts/screens/ws-d2';
mkdirSync(out, { recursive: true });
if (!process.argv.includes('--no-build')) buildPlayground();
const stop = await startPreview();
const browser = await launch();
const shots = [
  { name: 'overview', q: 'preset=iso' },
  { name: 'occupancy-top', q: 'preset=top' },
  { name: 'locate-sku', q: 'preset=iso&locate=SKU-001', settle: 2500 },
  { name: 'aisle', q: 'preset=aisle' },
  { name: 'skucount', q: 'preset=iso&mode=skuCount' },
  { name: 'fallback-2d', q: 'force2d=1&locate=SKU-001', twoD: true },
];
const results = [];
try {
  for (const [vp, opts] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(opts);
    for (const s of shots) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await page.goto(`${BASE}?data=mock&fallback=off&${s.q}`);
      if (s.twoD) {
        await page.waitForSelector('[data-twin-mode="2d"] canvas');
        await page.waitForTimeout(1500);
      } else await waitTwin(page, s.settle ?? 1500);
      const file = `${out}/${s.name}-${vp}.png`;
      await page.screenshot({ path: file });
      const st = s.twoD ? null : await page.evaluate(() => window.__twin.handle.stats());
      results.push({ file, calls: st?.calls, triangles: st?.triangles, errors });
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.errors.length)) process.exitCode = 1;
