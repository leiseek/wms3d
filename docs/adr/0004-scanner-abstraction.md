# ADR-0004 · 扫码抽象：HID（pre-IME 原生拦截 + JS 兜底）/ SPP（自研插件）/ 相机（ML Kit 捆绑 + 瞄准框）（v2）
- 状态：已接受 · **v2 2026-11-12**（按 R1 M2/M4/M8/M9/M10/M11/M12 修订） · **v2.1**（2026-11-12 按 R2 M-N5/M-N6/M-N7/M-N16 补充）

## 决策
1. 统一 `ScanHub`；去重按来源配置：枪源不做时间去重（仅 < 80ms 同帧），相机"离框再触发"；同 SKU 累加仅枪源默认开启。
2. **HID**：拦截点为 `dispatchKeyEventPreIme()`（自定义 FrameLayout 包住 WebView，位于 App 的 MainActivity），先于输入法；`Activity.dispatchKeyEvent` 为第二道防线。只拦截白名单设备（descriptor + VID/PID，首次测试扫码时记录）的 `KEYBOARD_TYPE_ALPHABETIC` 可打印键/Enter/Tab；`getUnicodeChar(metaState)`；终止符为主、150ms 空闲兜底。JS 兜底阈值：平均 < 30ms 且最大 < 120ms。
3. **SPP**：自研 Kotlin（社区插件与 Capacitor 8 匹配度不确定，且需要扫码语义）；权限 CONNECT + SCAN(neverForLocation) + 旧版 BLUETOOTH/ADMIN(maxSdk 30)；回退顺序 secure → insecure → （开关控制的）反射 channel 1；前台重连上限 3s + ACL 广播 + onResume 重连；帧切分空帧丢弃、半帧缓冲、512B 上限。
4. **相机**：`@capacitor-mlkit/barcode-scanning` `startScan()`（捆绑模型，无 GMS 依赖）；不用 `scan()`/`barcode_ui`；`cornerPoints` 瞄准框过滤 + 2 帧确认 + 格式限定；上半屏透明挖洞布局；torch 用 `@capawesome/capacitor-torch`。
5. 反馈走原生 SoundPool + haptics，成功音只在业务校验通过后播放。

## 后果
+ 中文输入法场景可用；密集标签误读显著降低；三种来源可在 web mock 中模拟。
− pre-IME 行为与 SPP 休眠需真机验证（R1/R10）；Hook 写在 App 工程而非插件内。

## v2.1 补充（R2）
- **相机**（M-N5）：`barcodesScanned` 不是逐帧事件，"2 帧确认 / 5 帧离框"改为"连续 2 次事件中心在框内"与"消失 ≥ 400ms 才可再触发"；`cornerPoints` 先除以 dpr；首次识别预算约 0.5s（插件 10-vote）。
- **文字输入**（M-N6，部分采纳）：放弃 `SHOW_FORCED`，改用 `packages/ui` 应用内字母数字键盘 + 硬键盘设置快捷入口；扫工牌登录推迟到 v1.1。
- **包裹层**（M-N16）：`ScannerInterceptLayout` 包住 `android.R.id.content` 的根布局，不改 WebView 父节点；`ACTION_MULTIPLE` 在 M3 处理。
- **验证**（M-N7）：Robolectric + JVM 单测 + Playwright 截图代替模拟器；真机为 M6 发布门禁，需 leo 提供平板与扫描枪。
