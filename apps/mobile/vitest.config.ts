import { defineConfig } from 'vitest/config';

// 单元/组件逻辑测试（node）。Playwright e2e 在 e2e/，不由 Vitest 收集。
export default defineConfig({
  test: {
    name: '@wms3d/mobile',
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', 'android/**'],
  },
});
