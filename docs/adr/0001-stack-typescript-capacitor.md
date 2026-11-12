# ADR-0001 · 客户端技术栈：TypeScript 单仓 + Capacitor（不选 Flutter / React Native / 原生 Kotlin）
- 状态：已接受（v1）· 日期：2026-11-11

## 背景
需要 PC Web 后台 + Android 平板/手机；3D 孪生需在 PC 与移动端都有；蓝牙 SPP/HID 与相机扫码需要原生能力；团队为小团队 + AI Agent，需在本机（Linux，无 GUI 模拟器）可构建可测试。

## 选项对比
| 维度 | **Capacitor + React（选）** | Flutter | React Native | 原生 Kotlin |
|---|---|---|---|---|
| 3D 复用 | three.js/R3F 一份代码 PC+移动 | 需另写（flutter_scene/Filament 或 WebView） | 需 expo-gl/R3F native，与 Web 有差异 | 需 SceneView/Filament，PC 另写 |
| PC 后台复用 | 同语言同组件库 | Flutter Web 不适合重后台表格 | RN Web 可用但生态弱 | 不复用 |
| 原生扫码 | 自研小插件（Kotlin ~500 行）+ ML Kit 社区插件 | 插件生态好 | 插件生态好 | 最佳 |
| 构建/测试（本机） | Web 部分可 Playwright 全测；APK 已在本机验证可构建 | 需 Flutter SDK，可行 | Metro + Gradle，较重 | Gradle，可行但 UI 测试需模拟器 |
| AI Agent 生产力 | TS 全栈、类型共享，最高 | Dart 单独一套 | 中 | 中 |
| 性能 | WebView 3D 需优化（实例化可达标） | 好 | 好 | 最好 |

## 决策
TypeScript 全栈单仓；移动端为 Capacitor 8 包装的 React 应用，原生能力通过自研 `@wms3d/capacitor-scanner`（SPP + HID 拦截）与 `@capacitor-mlkit/barcode-scanning@8`（捆绑模型）提供。

## 后果
+ 一份 3D 代码、一份契约类型、Web 端可全量自动化测试；2026-11-11 本机 spike：Capacitor 8 空工程 `assembleDebug` 成功生成 4MB APK。
− WebView 3D 性能需严格预算（见 06）；原生插件需 Kotlin 能力（范围小，可控）。
− 若未来需 iOS，Capacitor 同样支持（SPP 在 iOS 不可用，仅 HID/相机）。
