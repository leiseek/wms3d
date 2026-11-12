# R3 定向复核 · 移动端 / 3D / 标签（设计 v2.1，`21ac495` + M0a 代码）

- 评审人：独立评审 SubAgent · 日期：2026-11-12（PT）
- 范围：只复核本评审在 R1 中仍未关闭的条目和 R2 的 M-N1…N19。对照文档：02 §2/§3.1、03 §5–§7、04、06、07；对照代码：`apps/mobile`（MainActivity、ScannerInterceptLayout、ScanKeyBuffer、capacitor.config、errorPath 页、runtime-check、NSC、Manifest）。Capacitor 的 `BridgeWebViewClient` 已在线核对源码。
- **Verdict：APPROVE-WITH-NITS**（可以冻结 contract-v1）。下面 5 条 nit 都不改变契约形状，可在 M0b/M3 中顺手处理。

## A. 重点项复核
| 项 | 结论 | 核对要点 |
|---|---|---|
| **N1 bay 方向**（02 §2/§3.1、ADR-0008） | ✅ 关闭 | 我重新逐项推导过：<br>• 行进方向：水平巷道 +X、竖直巷道 +Z。<br>• 侧别推导：rot 0/90 → L，180/270 → R。<br>• rot 90 的取货面朝 −X，货架在巷道东侧，沿 +Z 行进时位于左手边 ✓。<br>• L 侧 `bayStart + 2i`、R 侧 `bayStart + 2(bays−1−i)`：面对 R 货架时，i = bays−1 是最右端，即行进起点端，取最小号 ✓。<br>• 取货面共线和巷道两侧的不等式（水平 `z_face(R) > z_face(L)`、竖直 `x_face(L) > x_face(R)`）✓。<br>• 黄金样例已覆盖"水平 + 竖直巷道，两侧各 2 个货架"✓ |
| **N2 停用 / 容量刷新**（03 §6/§7、06 §6） | ✅ 关闭 | `isActive`、`effectiveMax` 已移到 occupancy；ETag 改为内容哈希，同时覆盖启停、容量和提交乱序；新增 SSE `locations.changed`；补了"停用后 ETag 改变"的测试 ✓ |
| **N3 负载** | ✅ 关闭 | 服务端缓存、事件标脏、每秒最多重算一次；客户端最小间隔 2s/1s 且只在可见时拉取；01 §7 有指标 ✓ |
| **N4 实例化**（06 §2/§4、ADR-0005） | ✅ 关闭 | 紧凑槽位 + swap-remove + `mesh.count`，层过滤也用 count；断言 `opaque.count + empty.count == N_k`。draw call 预算 ≤ 80，各机位 LOD 分布算术自洽（72/48/40）✓ |
| 03 §6 SSE（N18、R1 M3） | ✅ 关闭 | 改为自研 fetch + eventsource-parser；401 走 single-flight 刷新；先建流再全量拉取 ✓ |
| 03 §5 `locationCode` 载荷形式（N12c） | ✅ 关闭 | 02 §3.2 与 03 §5 表述一致 ✓ |

## B. 其余条目
- **已关闭**：
  - R1：M4、M10、M11、M12、M13、M14、M15、M17；
  - R2：N5、N6（部分采纳，接受）、N7（改为 M6 门禁，接受）、N8、N9（改用 device_sessions 代交，接受：比在设备上保存多份 refresh token 的泄露面更小）、N10、N11、N13、N14、N15、N16、N17、N19（部分采纳，接受：现场验证确实受限于本机条件）。
- M0a 代码：
  - 包住 `android.R.id.content` 的根布局，WebView 父节点不变 ✓。
  - `dispatchKeyEventPreIme` 拦截点正确 ✓。
  - 华为 WebView 门槛、`server.errorPath`、ES5 独立提示页、运行时检测都已实现 ✓。
  - Manifest 蓝牙权限（含 `maxSdkVersion` 和 `neverForLocation`）、release NSC 禁明文 ✓。

## C. Nits（不阻塞冻结）
1. **[MINOR] errorPath 页不仅用于"WebView 过低"**
   - 位置：`public/webview-too-old.html`、04 §1
   - 问题：Capacitor 的 `BridgeWebViewClient.onReceivedError` / `onReceivedHttpError` 在**任何主框架加载错误**时都会加载 errorPath。现在页面固定写着"WebView 版本过低"，遇到其他错误时会误导现场人员。
   - 修复：页面按 `?missing=` 是否存在显示两种文案，另一种为"页面加载失败"，并加"重试"按钮（`location.replace('/')`）。
2. **[MINOR] 运行时检测放在 ES module 主包里，语法不兼容时根本执行不到**
   - 位置：`src/main.tsx`
   - 问题：版本号过了门槛、但 es2020 语法解析失败的 ROM 会直接白屏，检测代码没有机会运行。
   - 修复：在 `index.html` 的 module 脚本之前内联一段 ES5 classic `<script>`，完成特性检测和跳转；`main.tsx` 里的检测保留作为第二层。
3. **[MINOR] 包裹失败时静默跳过**
   - 位置：`MainActivity.wrapContentRoot()`
   - 问题：`childCount != 1` 时直接 return，pre-IME 拦截会无声失效，而这正是 R1 BLOCKER 的修复点。
   - 修复：失败时 `Log.w` 并上报诊断（设置页"扫码诊断"中显示"pre-IME：未启用"）。M3 补一个 Robolectric 用例，断言 content 下的根布局是 `ScannerInterceptLayout`。
4. **[MINOR] 超长缓冲的处理会产出残片**
   - 位置：`ScanKeyBuffer`
   - 问题：超过 `maxLen` 时只清空缓冲，后续字符会重新累积，遇到 Enter 时就输出一段残缺的码。
   - 修复：溢出后进入"丢弃直到终止符"状态，并补单测。另外 `ACTION_MULTIPLE` / `getCharacters()` 已按 R2 N16 的决议排在 M3 处理，确认保持在计划里。
5. **[MINOR] 换班代交依赖设备时钟，`deviceId` 也没进交易命令示例**
   - 位置：03 §5、02 §6.6
   - 问题：
     - 代交校验用 `clientCreatedAt ∈ device_sessions ±5 分钟`。离线平板时钟漂移超过 5 分钟时会被误拒，进入异常单。
     - 交易命令的 JSON 示例中没有 `deviceId` 字段，但代交规则依赖"单据 `deviceId`"。
   - 修复：
     - 在 contracts 中把 `deviceId` 列为必填，或明确改为取自令牌 `did`。
     - 客户端在每单记录"本次会话的服务端时间偏移"（登录或心跳时测得），服务端用校正后的时间比对；或者改为按 `device_sessions.id` 归属校验，彻底不依赖时钟。
