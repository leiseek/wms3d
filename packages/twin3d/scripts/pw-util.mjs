// Playwright 公共：构建 playground、起 vite preview（WS-D2 端口段）、启动 Chrome（无 GPU 时走 SwiftShader）。
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = fileURLToPath(new URL('.', import.meta.url));
export const PORT = Number(process.env.TWIN_PLAYGROUND_PORT ?? 4531);
export const BASE = `http://127.0.0.1:${PORT}/`;

export function buildPlayground() {
  execFileSync('bash', [`${here}playground.sh`, 'build'], { stdio: 'inherit' });
}

export async function startPreview() {
  const p = spawn('bash', [`${here}playground.sh`, 'preview'], {
    env: { ...process.env, TWIN_PLAYGROUND_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok)
        return () => {
          try {
            process.kill(-p.pid, 'SIGTERM');
          } catch {
            /* 已退出 */
          }
        };
    } catch {
      /* 未就绪 */
    }
    if (p.exitCode !== null) throw new Error(`preview 退出：${err}`);
    await sleep(100);
  }
  process.kill(-p.pid, 'SIGTERM');
  throw new Error('preview 启动超时');
}

export async function launch() {
  return chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome',
    headless: true,
    args: [
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--enable-webgl',
    ],
  });
}

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

/** 等模型就绪、首帧完成，并等相机飞行/脉冲稳定 */
export async function waitTwin(page, settleMs = 1200) {
  await page.waitForFunction(
    () =>
      window.__twin?.ready &&
      window.__twin.model &&
      window.__twin.handle?.engine()?.stats().firstFrameAt,
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(settleMs);
}
