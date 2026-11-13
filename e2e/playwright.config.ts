/**
 * 跨端 e2e（09 §1，ws-f）。用法（仓库根）：
 *   pnpm exec playwright test -c e2e                    # 对 mock（默认）
 *   E2E_TARGET=real pnpm exec playwright test -c e2e    # 对真实 API + 一次性克隆库
 *   E2E_UI=1 …                                          # 另起 admin/mobile Vite，跑浏览器冒烟
 * 也可直接 `bash scripts/e2e.sh [mock|real] [--ui]`。共享机器：workers=2（10 §6.4）。
 */
import { defineConfig, devices } from '@playwright/test';
import { STATE_DIR, ports, target, wantUi } from './lib/env.ts';

const chrome = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome';
const apiPort = target === 'real' ? ports.real : ports.mock;
const viteEnv = { PORT_API: String(apiPort), WMS_WS: 'ws-f' };

export default defineConfig({
  testDir: './tests',
  outputDir: `${STATE_DIR}results`,
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: `${STATE_DIR}report-${target}.json` }]],
  use: { trace: 'retain-on-failure', launchOptions: { executablePath: chrome } },
  projects: [
    { name: 'api', testDir: './tests/api' },
    ...(wantUi
      ? [
          {
            name: 'ui-admin',
            testDir: './tests/ui',
            testMatch: /admin\..*spec\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${ports.admin}` },
          },
          {
            name: 'ui-mobile',
            testDir: './tests/ui',
            testMatch: /mobile\..*spec\.ts/,
            use: { ...devices['Pixel 7'], baseURL: `http://127.0.0.1:${ports.mobile}` },
          },
        ]
      : []),
  ],
  webServer: wantUi
    ? [
        {
          command: `pnpm --filter @wms3d/admin exec vite --port ${ports.admin} --strictPort --host 127.0.0.1`,
          cwd: '..',
          url: `http://127.0.0.1:${ports.admin}`,
          env: viteEnv,
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: `pnpm --filter @wms3d/mobile exec vite --port ${ports.mobile} --strictPort --host 127.0.0.1`,
          cwd: '..',
          url: `http://127.0.0.1:${ports.mobile}`,
          env: viteEnv,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ]
    : undefined,
});
