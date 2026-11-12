# ADR-0004 · 扫码抽象：HID（原生拦截优先 + JS 兜底）/ SPP（自研插件）/ 相机（ML Kit 捆绑）
- 状态：已接受（v1）

## 背景
用户要求平板连接"SFP 蓝牙"扫码枪——业内为 **SPP（Serial Port Profile）**；绝大多数蓝牙枪同时支持 HID 键盘模式（配对即用）。

## 决策
1. 统一 `ScanHub` 事件流，页面不感知来源。
2. HID：Capacitor 插件在 `Activity.dispatchKeyEvent` 识别外接键盘设备并缓冲/吞键（避免输入法与输入框干扰）；JS `keydown` 时间间隔判定作为 Web/PC 兜底。
3. SPP：自研 Kotlin 插件（RFCOMM UUID 00001101-…，仅连已配对设备，帧切分可配置，自动重连）。社区插件（如 `@e-is/capacitor-bluetooth-serial` 仅支持到 Capacitor 6、`@nossdev/bluetooth-classic` 功能偏通用）与 Capacitor 8 匹配度/维护度不确定，且我们需要"扫码语义"（帧、编码、重连）——自研约 500 行，可控。
4. 相机：`@capacitor-mlkit/barcode-scanning@8` 的 `startScan`（捆绑 ML Kit 模型，无需 GMS）；不使用依赖 Play 服务的 Google code scanner（国内设备常无 GMS）。

## 后果
+ 三种来源可插拔、可模拟（web mock）；e2e 可覆盖业务流程。
− HID 原生拦截需在真机验证不同 ROM 的按键事件行为（风险 R1）。
