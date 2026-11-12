# R2 独立评审 · 移动端 / 扫码 / 3D 孪生 / 布局设计器 / 标签（设计 v2）

- 评审人：独立评审 SubAgent（非作者）· 日期：2026-11-12（PT）
- 评审对象：`docs/` v2（`bfafc4a..b7b0aaa`），对照 `reviews/R1-resolution.md` 的逐条决议
- 本轮网络与源码核实（2026-11-12）：
  - capawesome `capacitor-mlkit` barcode-scanning **Android 源码（main 分支）**：
    - `BarcodeScanner.java` 的 `voteForBarcodes()`：同一 rawValue **累计 ≥ 10 票**才上报，票数在整个扫码会话内只增不减（`stopScan` 时才清空）。
    - 只有存在"票数足够"的码时才 `notifyListeners`，**没有检出的帧不产生任何事件**。
    - `BarcodeScannerHelper.normalizeCornerPoints()`：按 `DisplayMetrics.widthPixels/heightPixels`（物理像素）和 FILL_CENTER 换算坐标。
  - Capacitor `Bridge.java` / `CapConfig.java`（main 分支）：
    - `isMinimumWebViewInstalled()` 对 `com.huawei.webview` 改用 **`android.minHuaweiWebViewVersion`**（默认 10），不受 `minWebViewVersion` 约束。
    - 版本过低时加载 `server.errorPath`；未配置则只打印日志。
  - 本机：`/dev/kvm` 属于 `root:pulse-access`，**box 用户（uid 1000）无权访问**；Android SDK 未安装 emulator 和 system-images。
- 统计：
  - **R1 复核**：34 条中 25 条确认关闭，9 条仍未关闭或需附加条件（见 §A）。
  - **新问题**：**BLOCKER 1 · MAJOR 8 · MINOR 10**（共 19 条，见 §B）。
- **结论：CHANGES-REQUIRED（范围很窄）**。必须在 M0b 契约冻结前修复的只有：
  - N1：右侧 bay 方向与巷道行进方向，属于 domain 几何与编码契约；
  - N2/N3：twin/occupancy 的字段与 ETag 语义，属于 API 契约。

  其余各项可以作为 M0a/M3/M4 的跟踪项，不阻塞冻结。上述 3 条修完后，Lead 自查并由本评审定向复核即可冻结，不需要再做一整轮 R3。

---

## A. R1 条目复核

| R1 | 决议 | 复核结论 | 说明 |
|---|---|---|---|
| M1 巷道重码 | 接受 | **关闭，但引出 N1（BLOCKER）** | 巷道级 bay + 奇偶分侧解决了重码。但右侧货架的 bay 方向与"面对取货面从左到右"的约定相矛盾，巷道行进方向也没有定义（N1） |
| M2 pre-IME | 接受 | 关闭（附 N16 nit） | 改为 `dispatchKeyEventPreIme`，写在 MainActivity，并保留第二道防线。方案正确 |
| M3 CORS / 证书 / SSE | 部分接受 | **接受该决议**（附 N18/N19 nit） | fetch-event-source + Bearer 足以解决鉴权。"重连后全量拉取"在 occupancy 全量可拉的前提下可以替代 Last-Event-ID，不采纳 ticket 我同意。条件是：连接顺序为先建流、`onopen` 之后再全量拉取（否则两者之间有空窗）；非 2xx 时 `onopen` 必须抛错（见 N18） |
| M4 去重 vs 累加 | 接受 | **未完全关闭 → N5** | 枪源的处理正确。相机的"连续 5 帧未检出才再触发"在插件里**无法观测**，因为无码帧不发事件 |
| M5 连续模式 | 接受 | 关闭（附 N10/N11 nit） | 倒计时、撤销、打断、灰绿勾都已具备 |
| M6 SQLite outbox | 接受 | 关闭 | |
| M7 刷新并发 | 接受 | 关闭（附 N17 nit） | "宽限期内返回同一个新 token"与"只存 hash"存在实现缺口 |
| M8 SPP 权限 | 接受 | 关闭 | |
| M9 SPP 重连 | 接受 | 关闭 | |
| M10 HID 识别 / 阈值 | 接受 | **未完全关闭 → N6** | 白名单、metaState、阈值都正确。但 `showSoftInput(SHOW_FORCED)` 在接着物理键盘时不可靠，且 API 33 起已弃用 |
| M11 相机误读 | 接受 | **未完全关闭 → N5** | 方向正确，但实现前提与插件实际行为不符（10 票门槛、物理像素坐标） |
| M12 透明挖洞 / 真机 spike | 部分接受 | **不接受当前形式 → N7** | "模拟器 spike"在本机做不了（无 KVM 权限、无镜像）。模拟器也覆盖不了 BT 和中文 IME，而且 adb 注入的按键来自虚拟设备，会被白名单排除 |
| M13 WebView 门槛 | 部分接受 | **接受"门槛替代 legacy"，但门槛不完整 → N8** | 我同意 es2020 + 版本门槛（WebView ≥ 99 已覆盖 es2020 语法与常用 API，不需要 polyfill）。但华为 WebView 走独立阈值（默认 10），提示页也需要 `server.errorPath` 并写成 ES5 纯 HTML |
| M14 三角形预算 | 接受 | **未关闭 → N4** | 双 mesh"缩放 0"槽位让实例数翻倍。`renderer.info` 的三角形计数和顶点着色开销都会翻倍，按设计自己的自动化断言，20k 档必然超标 |
| M15 空 / 有货归属 | 接受 | **功能关闭，性能问题转 N4** | |
| M16 分块 LOD | 接受 | 关闭（附 N13/N14 nit） | |
| M17 twinIndex 版本 | 部分接受 | **接受"全量 + ETag 替代 since"，但有条件 → N2、N3** | 全量拉取在 5k 档可行。但 ETag = hash(layoutVersion, max(movement.id)) 忽略了运行时属性（停用、容量 → fill）；twin 中也没有 `isActive`；20k × 50 台 × 每次变动都全量拉取，需要服务端缓存和客户端节流 |
| M18 坐标约定 | 接受 | **关闭（本身正确）**，但相邻问题见 N1 | 我逐项推导过：俯视右手系 +Z 向下不镜像、`rotation.y = −θ` 为俯视顺时针、局部 +x 为面对取货面时的右手方向，均自洽。示例 r1（x=2, z=6, rot 0, side L）也与"行进 +x 时左侧在北"一致 |
| M19 跨仓 / 命名空间 | 接受 | 关闭（附 N12 nit） | |
| M20 bwip-js → pdfkit | 接受 | 关闭 | |
| M21–M29 | 接受 | 关闭 | 已在 04 §1/§2/§3.7/§6、06 §5/§7 中逐项找到对应修改 |
| M30 X 维 / 容量 | 接受 | **基本关闭（附 N15 nit）** | 只有 100×50 提到了 0.375mm。横梁窄标 70×30 仍为 0.25mm，且条高 15mm + 字高 10mm 在 30mm 高的标签上放不下 |
| M31–M34 | 接受 | 关闭 | |

**仍未关闭或附条件的 R1 条目（9 条）**：M1（N1）、M4、M11（N5）、M10（N6）、M12（N7）、M13（N8）、M14、M15（N4）、M17（N2/N3）。

---

## B. 新问题

### BLOCKER

**N1. [BLOCKER] 右侧货架的 bay 方向与编号约定矛盾；巷道行进方向未定义**
- **位置**：02 §2（编号方向）、02 §3.1（`bay = bayStart + 2i`）、05 §2.1（阵列复制）、ADR-0008
- **问题**：
  - 02 §2 规定"面对取货面 bay 从左到右递增"，02 §3.1 规定"货架第 i 列（局部 +x）bay = bayStart + 2i"。
  - 推导：设巷道行进方向为北。
    - 左侧（西侧）货架面朝东。面对它时右手指向北，因此局部 +x = 行进方向，bay 1,3,5… 沿行进方向递增 ✓。
    - 右侧（东侧）货架面朝西。面对它时右手指向**南**，因此局部 +x = **逆**行进方向。
  - 结果是右侧编号锯齿化：沿行进方向走过 R1（bayStart 2，4 列）、R2（bayStart 10）时，看到的是 `8,6,4,2,16,14,12,10`。这破坏了"编码字典序 ≈ 行走顺序"（ADR-0008 的核心依据），也让 1 号和 2 号不再隔着巷道相对，pick_seq 默认值同样错乱。
  - 另外，"面向巷道行进方向"中的行进方向在模型里**根本没有定义**（aisle 只是一个 int），`side` 由人工填写，也就没有任何校验能发现填错。
- **修复（契约冻结前）**：
  1. 定义巷道方向：水平巷道（货架 rot 0/180）行进方向为 +x，竖直巷道（rot 90/270）为 +z。
  2. `side` 由旋转**推导**而不是人工填写：rot 0/90 → L，180/270 → R。可以保留覆盖字段，但 validate 时检查一致性。
  3. 编号公式按侧别区分：L 侧 `bay = bayStart + 2i`；R 侧 `bay = bayStart + 2·(bays−1−i)`，其中 bayStart 为该货架**沿行进方向起点端**的最小号。
  4. 02 §2 的"编号方向"改为："bay 沿巷道行进方向递增（左侧面对时从左到右，右侧面对时从右到左）；position 一律面对取货面从左到右"。
  5. `geometry-golden.json` 增加一组"同一巷道两侧各 2 个货架"的样例，断言 bay 1/2 对位、沿行进方向单调递增；阵列复制也按行进方向排序递增。

### MAJOR

**N2. [MAJOR] twin 契约缺 `isActive`；occupancy 的 ETag 忽略运行时属性**
- **位置**：03 §7、06 §4/§6、02 §4
- **问题**：
  - 06 §4 要求"停用 = 暗红"，但 `/twin` 的列式数组没有 `isActive`，`/twin/occupancy` 也没有。
  - `effectiveMax` 放在 `/twin` 中，而 `/twin` 的 ETag 只随 `layoutVersion` 变化，`max_qty` 是运行时 PATCH，所以 `fill` 的分母不会刷新。
  - occupancy 的 ETag = hash(layoutVersion, max(movement.id))：停用或修改容量不产生 movement，因此始终返回 304。
  - SSE 也没有 `location.updated` 事件。结果是 3D 上的停用、容量、fill 长期不准，违背"所见即所存"。
- **修复**：
  - `isActive`、`effectiveMax` 从 `/twin` 移到 occupancy（运行时数组）。
  - occupancy 的 ETag = hash(layoutVersion, max(movement.id), max(locations.updated_at))。
  - `PATCH /locations*` 提交后发送 SSE `locations.changed {layoutVersion, locationIds}`。
  - 补契约测试：停用后 occupancy 的 ETag 必须变化。

**N3. [MAJOR] "每次变动全量拉取"在 20k 档的服务端负载与移动端流量没有约束**
- **位置**：03 §6/§7、06 §6、01 §7
- **问题**：20k 仓位的 5 个数组 gzip 后约 80–150KB。作业高峰时全仓每秒都有交易，50 台设备各自防抖 500ms 后全量拉取，服务端每秒要做数十次全仓聚合，出口流量达到 MB/s 级。目标服务器只有 2C4G，与 01 §7 的"扫码提交 p95 ≤ 150ms"抢资源。
- **修复**：
  - 服务端按 ETag 键**内存缓存** occupancy 结果（同一版本只算一次，单进程即可），压缩结果也一并缓存。
  - 客户端防抖改为"最少间隔 2s（移动端）/ 1s（PC）"，并且只在 3D 可见时拉取（不可见时只记脏标记）。
  - 在 01 §7 增加指标："20k 档、50 客户端、每秒 2 笔交易时，occupancy 接口 CPU < 20%"，并写进 M4.5 压测。

**N4. [MAJOR] "两个 mesh × 每仓位一槽、缩放 0 隐藏"让实例数翻倍，三角形预算与自动化断言失效**
- **位置**：06 §2/§3/§4/§8、ADR-0005
- **问题**：
  - three 的 `renderer.info.render.triangles` 按 `instanceCount × 索引数` 计数，缩放为 0 的实例照样执行顶点着色器（光栅化时才被丢弃）。BinsOpaque 和 BinsEmpty 各分配 N 个实例，实际提交量是 2N。
  - 按 06 §8 自己的估算：
    - 5k 档：仓位 50k → 100k，合计约 127k，逼近 150k；
    - 20k 档全近景：400k + 108k ≈ 508k，常规视角也很难低于 300k，**Playwright 断言必然失败**。
  - 层过滤同样用缩放 0，问题会叠加。
- **修复**：
  - 每个块的两个 mesh 改为**紧凑存储 + `mesh.count`**：维护 `slotOf[loc]` / `locOf[slot]`，移出时把最后一个实例换到空位（swap-remove），再更新两个槽位的矩阵和颜色范围。拾取是解析式的，不受影响。
  - 备选方案：单 mesh + 自定义 `instanceAlpha` attribute，空仓位与有货仓位共用一次 draw；或者使用 three 0.187 的 `BatchedMesh`，它有原生的逐实例可见性和裁剪。
  - 层过滤也走 count 或可见性机制。
  - 单测断言 `opaque.count + empty.count == N_k`。

**N5. [MAJOR] 相机策略建立在与插件实际行为不符的前提上**
- **位置**：04 §2.3/§2.4
- **问题**（依据 capawesome Android 源码）：
  - (a) 插件内部对每个 rawValue 要求**累计 10 票**才上报，首次识别延迟约为 10 个分析帧（0.3–0.7s）。票数在整个会话内只增不减，所以瞄准框外边缘反复出现的邻近码最终也会被上报；设计中的"双帧确认"实际是冗余的。
  - (b) 无码帧不发事件，"连续 5 帧未检出才允许再触发"在 JS 侧无法实现。
  - (c) `cornerPoints` 已按 FILL_CENTER 换算成**物理像素**屏幕坐标（`DisplayMetrics`），使用前需要除以 `devicePixelRatio`；edge-to-edge 下还要核对系统栏偏移。
- **修复**：
  - 再触发规则改为**时间间隙**：同一码超过 ≥ 400ms 没有出现在 `barcodesScanned` 事件里，就视为已离框。
  - 瞄准框过滤保留，这是对抗累计投票的关键。
  - 双帧确认改为"连续两次事件中心都在框内"。
  - 坐标换算写明 `x/dpr, y/dpr` 并做 spike 标定。
  - 在 04 中写明首帧延迟预算约 0.5s；如果实测太慢，可以用 patch-package 把投票阈值参数化（例如 3），或者在自研插件里直接调用 ML Kit。

**N6. [MAJOR] 接 HID 枪后的文字输入方案不可靠**
- **位置**：04 §2.1
- **问题**：
  - `InputMethodManager.SHOW_FORCED` 从 API 33 起弃用，并且在"已接物理键盘、系统设置为不显示虚拟键盘"时，多数 IME 的 `onEvaluateInputViewShown()` 返回 false，强制显示依然无效。
  - "显示屏幕键盘"是 `Settings.Secure` 中的系统项，App 无法写入，只能靠操作员手动开启。
  - 结果是：枪一直连着时，登录密码和 SKU 名称搜索都无法输入，现场常见的折中是关掉枪。
- **修复**：
  - 在 `packages/ui` 中提供 **App 内字母数字键盘**（与数字键盘同一组件族），用于搜索、手输编码和登录用户名。密码框仍走系统 IME，并在登录页显示"若无键盘请开启'显示屏幕键盘'"的引导，附跳转到 `Settings.ACTION_HARD_KEYBOARD_SETTINGS`（API 24+ 可用）的按钮。
  - 支持"扫码登录"：用户卡上的二维码携带一次性绑定码，从而避开现场输入密码。
  - 在 M3 第 1 天的 spike 中实测 2 款 IME。

**N7. [MAJOR] M12 的"模拟器 spike"在本机做不了，即使做了也覆盖不到风险点**
- **位置**：10 M3 / D3、04 §7、风险 R10、R1-resolution M12
- **问题**：
  - 本机 box 用户没有 `/dev/kvm` 权限，SDK 里也没有 emulator 和系统镜像。
  - 即使有模拟器：它没有经典蓝牙（SPP 测不了）；AOSP 镜像没有中文拼音 IME；`adb shell input` 注入的按键来自**虚拟设备**（`isVirtual=true`），会被 HID 白名单排除，pre-IME 路径根本走不到；相机也只有虚拟场景。
  - 结果是 D3"模拟器录屏连续上架"无法兑现，三大原生风险（R1/R2/R10）在交付时全部处于未验证状态。
- **修复**（我接受"没有真机"这一事实，但不接受当前写法）：
  1. 10 M3 改为可在本机执行的验证：
     - Robolectric 单测直接调用 `ScannerInterceptLayout.dispatchKeyEventPreIme()`，覆盖白名单判定、缓冲、吞键返回值；
     - SPP 帧切分和重连状态机用纯 Kotlin 单测（注入假的 socket 流）；
     - 透明挖洞用 Playwright 在 Web 端对 `barcode-scanner-active` 下的 DOM 做截图断言。
  2. 增加 debug-only 开关"把虚拟键盘当作白名单设备"，供将来有模拟器或真机时使用 adb 注入。
  3. D3 改为"web mock 录屏 + 单测报告"。
  4. 交付清单（M6）中把"HID pre-IME、SPP、相机误读、无 GMS 机、手势导航"列为**待现场验证的发布门槛**，并附《现场 30 分钟验收脚本》。
  5. 写好降级预案：若 pre-IME 在某款 ROM 上无效，默认改用 SPP 模式，并要求扫码页保持"无焦点"。
  6. 尽早请 leo 提供 1 台平板 + 1 把枪，由 Lead 在开发计划中列为依赖项。

**N8. [MAJOR] WebView 门槛对华为无效，提示页未落地**
- **位置**：04 §1、01 §1、R1-resolution M13
- **问题**：
  - Capacitor 对 `com.huawei.webview` 使用 `android.minHuaweiWebViewVersion`，默认值 10，几乎不起拦截作用。而华为、荣耀国内机正是"无 GMS"的主力机型。
  - 版本过低时，Capacitor 只有配置了 `server.errorPath` 才会显示错误页，否则加载主包后白屏。
  - 设计里的"中文提示页"如果放在 Vite 主包中，同样会因为 es2020 语法在旧 WebView 上崩溃。
- **修复**：
  - `capacitor.config.ts` 同时设置 `android.minWebViewVersion: 99`、`android.minHuaweiWebViewVersion: <实测值>`、`server.errorPath: 'webview-too-old.html'`。
  - `webview-too-old.html` 写成**独立的 ES5 纯 HTML**，不经 Vite 转译，放在 `public/` 下。
  - 主包入口再加一道运行时特性检测（`'at' in Array.prototype` 和 WebGL2），兜底那些版本号能通过门槛但实际能力不足的 ROM。

**N9. [MAJOR] 共用平板换班：BLOCKED_AUTH 与"登出前 outbox 必须为空"互相锁死**
- **位置**：04 §5、03 §5（performedBy = 令牌用户）
- **问题**：
  - 平板通常多人轮班共用。A 离线作业后下班，outbox 还有 PENDING。设计要求登出前 outbox 必须为空，所以 A 无法登出；B 想接班，就只能"导出后用 MANAGER 口令强制清空"，A 的单据实际被丢弃，或者等 A 回来重新登录。
  - 在"网络不稳的仓库角落"这是常态，不是边缘场景。
- **修复**：
  - 设备上按用户分别保存 refresh token（Keystore 中多条记录）。A"交班登出"时只结束 A 的前台会话，保留 A 的 refresh token 供发送器在后台以 A 的身份补传 A 的单据；B 正常登录作业。
  - A 的 refresh token 过期或被撤销时，对应单据进入 BLOCKED_AUTH，并在后台"全仓待同步"中提示主管。
  - 需要服务端配合：允许同一设备同时存在多个 family（02 refresh_tokens 已有 device_id，不需要改表）。

### MINOR

**N10. [MINOR] 自动提交倒计时与数量键盘、超量提示冲突**（04 §3.1/§3.2）
- **问题**：操作员正在数量键盘上输入时，3s 倒计时会把未输完的数量提交出去。出库时本地发现超量，现在只是"提示"，倒计时到了仍会提交。
- **修复**：键盘打开时暂停倒计时，关闭后重新计时。出库超量（按缓存判断）时暂停自动提交，要求点"仍然提交"，或者扫码确认。

**N11. [MINOR] 打断式拒绝弹层期间到达的扫码没有规则**（04 §3.1）
- **修复**：弹层显示期间，HID/SPP/相机的扫码一律丢弃，并播放错误音和短震（提示"先处理错误"），不入队也不累加。写进 §3.7 的转移表，并做组件测试。

**N12. [MINOR] 分类器的顺序与规范化**（02 §3.2、03 §5）
- **问题**：
  - (a) 先做前缀正则匹配的话，形如 `AB1.234` 的 SKU 条码会被误判为 `WRONG_WAREHOUSE`。
  - (b) 枪的 Caps Lock 或大小写设置会输出小写的 `wh1.a03-…`。
  - (c) 离线暂存的原文是完整载荷 `WH1.A03-17-C02`，而交易命令示例中的 `locationCode` 用的是裸编码。
- **修复**：
  - 先用整串精确匹配 `barcode_registry` 和本地缓存，失败后再解析前缀。
  - 仓位和货架载荷在匹配前统一转大写，SKU 条码保持原样。
  - 在契约里写明：`locationCode` 接受载荷形式和裸编码两种，服务端统一剥离并校验前缀。

**N13. [MINOR] FrameFar 必须是 InstancedMesh；拾取必须尊重 LOD 与层过滤**（06 §2/§5）
- **问题**：FrameFar 要求"按货架汇总占用着色"，需要逐货架的颜色，所以必须是实例化的（每块 1 个 InstancedMesh），不能是合并几何。
- **修复**：
  - 写明 FrameFar 为每块一个 InstancedMesh。
  - 解析式拾取按当前块的 LOD 决定命中单位：远景只命中货架，近景命中仓位。层过滤隐藏的层不参与命中。

**N14. [MINOR] draw call 算术自相矛盾**（06 §2/§8）
- **问题**：最坏情况是 20 块全部中景，约 68 次，超过 ≤ 60 的预算。"等轴全景"是验收机位之一，正好可能落在 18–40m 的中景区间。
- **修复**：给每个验收机位写明预期的 LOD 分布，或者把预算改为 ≤ 80。R1 引用的 [T4] 给出的移动端阈值是 < 100，≤ 80 仍然保守。

**N15. [MINOR] 窄标签版面与 X 维**（07 §2）
- **问题**：
  - 70×30 是横梁标签，扫描距离最远，X 维却仍为 0.25mm。
  - 30mm 的标签高度放不下"条高 ≥ 15mm + 字高 ≥ 10mm + 上下边距"。
- **修复**：
  - 70×30 采用"编码字高 7mm + 条高 15mm"的版面。
  - 提供"裸编码载荷"选项：10 字符约 165 模块 × 0.375mm ≈ 62mm，可以放下，代价是失去跨仓校验，适合单仓用户。
  - `maxModules` 按 dpi 分别给出：300dpi 的 X 维与 203dpi 不同，模块容量也不同。

**N16. [MINOR] pre-IME 包裹层的实现细节**（04 §2.1）
- **问题**：
  - 把 Capacitor 的 WebView 重新挂到新的父节点下，可能破坏 Capacitor 8 的系统栏和 insets 处理，以及插件对 `bridge.getWebView().getParent()` 的假设（ML Kit 插件会把 PreviewView 插到 WebView 的父节点里）。
  - 部分扫码枪用 `ACTION_MULTIPLE` 或 `KEYCODE_UNKNOWN` + `getCharacters()` 发送非 ASCII 字符。
- **修复**：
  - 改为包裹 `android.R.id.content` 下的根布局，WebView 保持原有父节点。M0a spike 时与 ML Kit 的 `startScan` 联合验证相机预览层级。
  - HidWedgeBuffer 同时处理 `ACTION_MULTIPLE` 和 `getCharacters()`。

**N17. [MINOR] 刷新宽限"返回同一个新 token"与"只存 hash"矛盾**（03 §2、02 §5 refresh_tokens）
- **问题**：服务端只保存 token 的 hash，宽限期内无法把"同一个"新 token 原样再发一次。
- **修复**：二选一：
  - 用服务端密钥加密暂存替换 token 的明文 60s（`replacement_ciphertext`，到期清除）；
  - 宽限期内签发一个同 family 的兄弟 token，并允许两者在短时间内同时有效。

  契约中写明采用哪一种。

**N18. [MINOR] fetch-event-source 的使用约束**（03 §6）
- **问题**：
  - 该库在 `onopen` 不抛错时，对 401/5xx 会按默认间隔无限重试，过期 token 会持续冲击服务端。
  - `openWhenHidden` 默认为 false：页面隐藏时断流，回到前台时重连并全量拉取，这符合预期，但需要写明。
  - 该库 2.0.x 自 2021 年起已无维护。
- **修复**：
  - 在 `packages/api-client` 里封装 `connectEvents()`：`onopen` 校验 `response.ok && content-type`，401 时抛出可识别的错误，交给 single-flight 刷新，其他错误按 1s→30s 退避。
  - 连接顺序固定为"先建流，`onopen` 之后再全量拉 occupancy"。
  - 锁定版本；该库只有约 300 行，必要时 vendor 进仓库。

**N19. [MINOR] user 锚点对 WebView 生效需实测；SPKI 只在启动时校验**（04 §1）
- **修复**：
  - M0a spike 用自签 CA 验证 WebView `fetch` 是否遵守 `network_security_config` 的 user 锚点（与 Android 版本相关），把结论写回 04 §1。
  - 文档中明确：SPKI 校验只能防"配置被篡改或指向错误服务器"，防不了运行期的 MITM，后者依赖设备上不存在恶意 CA。同时把"服务器证书轮换后需要重新扫配置码"写进运维手册。

---

## C. 冻结建议

| 项 | 是否阻塞 M0b | 归属 |
|---|---|---|
| N1 右侧 bay 方向 / 行进方向 / side 推导 | **是**（domain 几何 + 编码 + golden fixtures） | Lead |
| N2 twin/occupancy 字段与 ETag、`locations.changed` 事件 | **是**（API 契约） | Lead |
| N3 occupancy 缓存与客户端节流 | 部分（ETag 定义随 N2 冻结；缓存和节流属于实现） | Lead → WS-A/WS-C |
| N12(c) `locationCode` 接受载荷形式 | 是（契约措辞，一行） | Lead |
| N17 刷新宽限的实现方式 | 是（契约 / 表结构一行） | Lead |
| N4、N13、N14 | 否（twin3d 内部） | WS-D2 / M4 |
| N5、N6、N10、N11、N16 | 否 | WS-C / M3 |
| N7、N8、N19 | 否（M0a/M3 计划与配置） | Lead / WS-C |
| N9 | 否（客户端为主，服务端已支持多 family） | WS-C / WS-A |
| N15 | 否 | WS-E / M2 |

**Verdict：CHANGES-REQUIRED**。只需修复 N1、N2，以及 N3/N12(c)/N17 的契约措辞，无需新一轮全面评审。修完后由本评审对 02 §2/§3.1、03 §6/§7 做定向复核，即可打 `contract-v1`。
