# native/capacitor-scanner（WS-C）

Capacitor 原生插件 `Wms3dScanner`（Kotlin）：HID 缓冲与设备白名单（`HidWedgeBuffer`/`DevicePolicy`/`HidRouter`）、
SPP 串口（`SppClient` + `SppFrameSplitter` + `Backoff`）、反馈音（SoundPool）、SPKI 指纹校验（`SpkiPin`）、
软键盘、Keystore AES-GCM 加密存储（`CryptoBox` + `KeystoreKeys`）。设计见 `docs/04-mobile.md` §2、§7。

- **接入方式**：不是 npm 包（WS 不得改 package.json/lockfile）。`apps/mobile/android/settings.gradle` 以本地 Gradle 模块
  `:wms3d-capacitor-scanner` 引入，`MainActivity` 在 `super.onCreate` 前 `registerPlugin(ScannerPlugin.class)`；
  JS 侧类型在 `src/definitions.ts`，注册在 `apps/mobile/src/native/bridge.ts`。见 `docs/contract-requests/ws-c-1.md`。
- **pre-IME Hook** 在 App 的 `MainActivity` / `ScannerInterceptLayout`（插件 API 无法挂到 Activity 的 pre-IME 管线）。
- **测试**：`pnpm apk:debug` 同时跑 `testDebugUnitTest`（本模块 JVM 单测 + App 的 Robolectric pre-IME 测试）。
- **待真机验证**：SPP 连接/重连/休眠唤醒、蓝牙权限弹窗、反馈音量与振动、Keystore 在各 ROM 的行为、
  `verifyServerPin` 对内部 CA 的握手、真实中文输入法焦点下 HID 零吞字。
