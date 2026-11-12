import { defineConfig } from '@playwright/test';

/**
 * WS-B 后台 E2E（对契约 mock 跑，09 §2）。运行：
 *   pnpm exec playwright test -c apps/admin/e2e/playwright.config.ts
 * 端口取本 worktree 的 .env.local（PORT_API / PORT_ADMIN）；已在跑的 mock / dev server 会被复用。
 * mock 为进程内存状态：每次全新启动保证可重复（CI 不复用）。
 */
const apiPort = process.env.PORT_API ?? '4200';
const adminPort = process.env.PORT_ADMIN ?? '4210';
const root = new URL('../../..', import.meta.url).pathname;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  outputDir: '/tmp/wms3d-ws-b-pw-results',
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${adminPort}`,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
    acceptDownloads: true,
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome',
      args: [
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--enable-webgl',
      ],
    },
  },
  webServer: [
    {
      command: `pnpm --dir ${root} mock`,
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `pnpm --dir ${root} dev:admin`,
      url: `http://localhost:${adminPort}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
