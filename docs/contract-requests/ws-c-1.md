# WS-C-1 · 原生扫码插件打包方式 + 移动端 e2e 脚本入口

- 工作流：ws-c
- 阻塞：否（两项均已用不改 package.json 的方式落地，可先合并）

## 1. `native/capacitor-scanner` 作为 npm 包

- 现状：ws-c 不能新增/修改任何 package.json，因此插件以**本地 Gradle 模块**接入：
  `apps/mobile/android/settings.gradle` include `:wms3d-capacitor-scanner`（projectDir = `native/capacitor-scanner/android`），
  `app/build.gradle` `implementation project(':wms3d-capacitor-scanner')`；`MainActivity` 在 `super.onCreate` 前
  `registerPlugin(ScannerPlugin.class)`。TS 定义由 `apps/mobile/src/native/bridge.ts` 以相对路径
  `../../../../native/capacitor-scanner/src/definitions.ts` 引入。
- 影响：`npx cap sync` 不会自动发现该插件（因此手动 include/register，已在 `pnpm apk:debug` 验证）。
- 建议（Lead，非阻塞）：后续给 `native/capacitor-scanner` 加 `package.json`（`name: @wms3d/capacitor-scanner`，
  `capacitor.android.src: android`），`apps/mobile` 依赖 `workspace:*`，即可改回标准 `cap sync` 自动注册，
  届时 ws-c 删除手动 include 与相对路径 import。

## 2. 移动端 e2e 入口

- 现状：Playwright 用例在 `apps/mobile/e2e/`（16 个，phone 412×915 + tablet 1280×800），使用根已有的
  `@playwright/test` 与本机 `/usr/bin/google-chrome`，进程内契约 mock（`VITE_API_MOCK=inproc`，Vite 端口默认 4330，
  可用 `WMS_E2E_PORT` 覆盖）。运行：`pnpm exec playwright test -c apps/mobile/e2e/playwright.config.ts`。
- 建议（Lead / WS-F，非阻塞）：在 `apps/mobile/package.json` 加 `"e2e": "playwright test -c e2e/playwright.config.ts"`，
  并视 CI 资源决定是否纳入 `pnpm verify` 之外的 e2e 阶段。不需要新增依赖。

## 3. 类型声明

- `apps/mobile/tsconfig.json` include 了 `../../packages/twin3d/src/troika.d.ts`（twin3d 以源码导出，其环境声明需被消费方看到）。
  建议 WS-D2 将该声明改为在 `src/index.ts` 中 `import type` 可达的模块声明，或在包内 `types` 字段导出，消费方即可去掉此 include。

---
**Lead 决定（2026-11-12 PT，contract-v1.2）**
1. 插件打包：**接受方向，排到 M4.5 由 Lead 统一做**。要加 `native/capacitor-scanner/package.json` 和 `apps/mobile` 的 `workspace:*` 依赖，会改 lockfile 和 Gradle 配置，与你正在进行的工作有冲突风险。在此之前保留本地 Gradle 模块 + 手动 register。
2. e2e 入口：**已做**。`apps/mobile` 新增 `"e2e": "playwright test -c e2e/playwright.config.ts"`；暂不纳入 `pnpm verify`，WS-F 在 CI 脚本中作为 e2e 阶段调用。
3. troika 类型声明：**转给 WS-D2**（M4.5 打磨项）：在 `packages/twin3d` 内让声明从 `src/index.ts` 可达，之后 apps/mobile 去掉 include。
