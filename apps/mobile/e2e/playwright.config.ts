import { defineConfig } from '@playwright/test';

/**
 * 移动端 web mock e2e（docs/workstreams/ws-c.md 验收）：进程内契约 mock（VITE_API_MOCK=inproc），
 * 每次页面加载一份独立数据；手机竖屏 + 平板横屏两种视口。运行：
 *   pnpm exec playwright test -c apps/mobile/e2e/playwright.config.ts
 */
const port = Number(process.env.WMS_E2E_PORT ?? 4330);
const chrome = process.env.WMS_E2E_CHROME ?? '/usr/bin/google-chrome';

export default defineConfig({
  testDir: '.',
  outputDir: process.env.WMS_E2E_OUT ?? '/tmp/wms3d-ws-c-e2e',
  workers: 2,
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: chrome },
    hasTouch: true,
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'phone',
      use: { viewport: { width: 412, height: 915 }, isMobile: true, deviceScaleFactor: 2 },
    },
    {
      name: 'tablet',
      use: { viewport: { width: 1280, height: 800 }, isMobile: true, deviceScaleFactor: 1.5 },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort --host 127.0.0.1`,
    cwd: '..',
    env: { VITE_API_MOCK: 'inproc' },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
