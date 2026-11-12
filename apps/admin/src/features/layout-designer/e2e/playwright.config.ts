import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/** WS-D1 设计器 Playwright（对 contract mock）。共享机器：workers=1（同一个 mock 实例，用例串行），端口 4431/4432。 */
const dir = fileURLToPath(new URL('.', import.meta.url));
const sh = fileURLToPath(new URL('../dev/designer.sh', import.meta.url));
const MOCK = Number(process.env.D1_E2E_MOCK_PORT ?? 4431);
const WEB = Number(process.env.D1_E2E_WEB_PORT ?? 4432);
export default defineConfig({
  testDir: dir,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: '/tmp/ws-d1-pw-results',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB}`,
    viewport: { width: 1600, height: 960 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
  },
  webServer: [
    {
      command: `bash ${sh} serve-mock`,
      env: { PORT_API: String(MOCK) },
      url: `http://127.0.0.1:${MOCK}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `bash ${sh} serve-vite`,
      env: { PORT_API: String(MOCK), DESIGNER_PORT: String(WEB) },
      url: `http://127.0.0.1:${WEB}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
