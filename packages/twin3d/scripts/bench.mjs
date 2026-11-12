// 性能基准（06 §8）：5k / 20k 仓位 × 3 机位（全景俯视 / 等轴全景 / 巷道内）× 桌面 / 手机视口。
// 断言 draw calls ≤ 80、三角形 5k ≤ 150k / 20k ≤ 300k；记录首屏时间与旋转帧时间（无 GPU 时为 SwiftShader 软件渲染，仅供参考）。
// 用法：flock /tmp/wms3d-perf.lock node packages/twin3d/scripts/bench.mjs [--no-build]
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, VIEWPORTS, buildPlayground, launch, startPreview, waitTwin } from './pw-util.mjs';

const BUDGET = { bench5k: { calls: 80, tris: 150_000 }, bench20k: { calls: 80, tris: 300_000 } };
if (!process.argv.includes('--no-build')) buildPlayground();
const stop = await startPreview();
const browser = await launch();
const rows = [];
let failed = false;
try {
  for (const [vp, opts] of Object.entries(VIEWPORTS)) {
    const ctx = await browser.newContext(opts);
    for (const tier of ['bench5k', 'bench20k']) {
      for (const preset of ['top', 'iso', 'aisle']) {
        const page = await ctx.newPage();
        const t0 = Date.now();
        await page.goto(`${BASE}?data=${tier}&bench=1&ui=0&preset=${preset}`);
        await waitTwin(page, 1000);
        const r = await page.evaluate(async () => {
          const h = window.__twin.handle;
          const eng = h.engine();
          const st = h.stats();
          // 旋转 60 帧（每帧改方位角并渲染），取平均帧时间
          const c = eng.controls;
          const target = c.target.clone();
          const off = eng.camera.position.clone().sub(target);
          const frames = [];
          let last = performance.now();
          for (let i = 0; i < 60; i++) {
            await new Promise((res) => requestAnimationFrame(res));
            const a = (i / 60) * 0.6;
            const x = off.x * Math.cos(a) - off.z * Math.sin(a);
            const z = off.x * Math.sin(a) + off.z * Math.cos(a);
            eng.camera.position.set(target.x + x, target.y + off.y, target.z + z);
            c.update();
            eng.renderNow();
            const now = performance.now();
            frames.push(now - last);
            last = now;
          }
          frames.sort((a, b) => a - b);
          return {
            n: window.__twin.model.locations.id.length,
            calls: st.calls,
            triangles: st.triangles,
            chunks: st.chunks,
            firstFrameMs: Math.round(st.firstFrameAt),
            dataReadyMs: Math.round(window.__twin.dataReadyAt),
            frameP50Ms: Math.round(frames[30] * 10) / 10,
            fps: Math.round(1000 / (frames.reduce((s, v) => s + v, 0) / frames.length)),
          };
        });
        const b = BUDGET[tier];
        const ok = r.calls <= b.calls && r.triangles <= b.tris;
        if (!ok) failed = true;
        rows.push({ viewport: vp, tier, preset, ...r, budget: b, ok, wallMs: Date.now() - t0 });
        console.log(
          `${ok ? 'OK ' : 'BAD'} ${vp.padEnd(7)} ${tier.padEnd(8)} ${preset.padEnd(5)} n=${r.n} calls=${r.calls} tris=${r.triangles} ` +
            `chunks(n/m/f/culled)=${r.chunks.near}/${r.chunks.mid}/${r.chunks.far}/${r.chunks.culled} first=${r.firstFrameMs}ms p50=${r.frameP50Ms}ms`,
        );
        await page.close();
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  stop();
}
const outDir = fileURLToPath(new URL('../bench-results/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const gpu = 'headless Chrome + SwiftShader（软件 WebGL2，无 GPU）';
writeFileSync(
  `${outDir}latest.json`,
  JSON.stringify({ at: new Date().toISOString(), renderer: gpu, rows }, null, 2) + '\n',
);
if (failed) {
  console.error('性能预算未通过');
  process.exitCode = 1;
}
