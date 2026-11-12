# R1 独立评审 · 移动端 / 扫码 / 3D 孪生 / 布局设计器 / 标签

- 评审人：独立评审 SubAgent（非作者）· 日期：2026-11-11（PT）· 评审对象：`docs/` v1（commit `23f8b32`）
- 范围：Android 客户端（Capacitor 8 单 APK）、HID/SPP 扫码枪、摄像头扫码、扫码作业 UX、离线队列、移动端 3D、PC 布局设计器、标签打印。领域/API 只在与上述范围交叉时提及。
- 网络核实（2026-11-11）：
  - `@capacitor-mlkit/barcode-scanning` README：8.x 对应 Capacitor ≥8；`startScan()` 把相机画在 WebView **后面**（要求 DOM 透明）；`cornerPoints` 只有 `startScan` 提供；手电筒已拆到单独的 `@capawesome/capacitor-torch`；`scan()` 依赖 Play 服务；默认依赖 `com.google.mlkit:barcode-scanning:17.3.0`（捆绑模型）。
  - Capacitor `Bridge.java`：`setMediaPlaybackRequiresUserGesture(false)`（无需手势即可播放 Web 音频）；最低 WebView 版本检查可用（`android.minWebViewVersion`，另有华为 WebView 分支）。
  - bwip-js README：提供自定义 drawing 接口和 pdfkit 可缩放条码示例；pdfkit 本身**不能**导入 SVG。
- 统计：**BLOCKER 3 · MAJOR 17 · MINOR 14**（共 34 条）

---

## BLOCKER

1. **[BLOCKER] 仓位编码不含货架号，同一巷道必然重码**（02 §3、ADR-0008、06 §3、07 §2）
   - **问题**：默认模式 `{Zone}{Aisle:2}-{Bay:2}-{Level}{Pos:2}` 里没有 rack 段。`expandRack()` 按模板在货架内部从 1 开始编 bay，而一条巷道两侧至少有 2 个货架（通常沿巷道还有多个）。两侧的 `A03-01-A01` 会重复，`unique(warehouse_id, code)` 发布时直接失败。种子数据"6 巷道×8 货架"同样会撞码。标签印出的码和 3D 位置也就无法一一对应。
   - **修复**：在 domain 里明确"巷道级 bay 编号"规则，二选一：
     - (a) 发布时按巷道内物理顺序给全局 bay 连续编号，左侧奇数、右侧偶数（行业常用）。在 `expandLayout` 中计算，同时写入 `locations.bay`；
     - (b) 模式加入 rack 段，如 `{Zone}{Aisle:2}-{Rack:2}-{Bay:2}-{Level}{Pos:2}`。
   - 同时在 `validateLayout` 中加"编码生成后唯一性"校验，并补单测：两排对面货架、阵列复制 8 个货架。

2. **[BLOCKER] HID"原生拦截"挂在 `Activity.dispatchKeyEvent`，位于输入法之后，挡不住中文输入法**（04 §2.1、ADR-0004、风险 R1）
   - **问题**：Android 的按键管线是 `ViewPreImeInputStage → ImeInputStage → … → ViewPostImeInputStage`，而 `Activity.dispatchKeyEvent` 在 PostIme 阶段才被调用。只要 WebView 里有可编辑元素获得焦点、IME 处于激活状态（搜索框、登录框、数量框、异常单编辑），搜狗、百度等中文输入法会**先**收到物理键盘事件并进入拼音组字，插件根本拿不到原始字符。文档的核心卖点"吞键避免输入法乱码"在最常出问题的场景下不成立。
   - **修复**：
     - 拦截点改为 **pre-IME**：在 `MainActivity` 中用自定义 `FrameLayout` 包住 Capacitor 的 WebView，重写 `dispatchKeyEventPreIme()`，对扫码枪设备的按键缓冲后返回 `true`。`dispatchKeyEventPreIme` 会沿焦点链从父 View 下发，能先于 IME 拿到事件。
     - 保留 `dispatchKeyEvent` 作为二道防线。
     - 扫码作业页仍坚持"无可编辑焦点"。
     - 在 Kotlin 单测和真机清单里加用例："焦点在中文输入法搜索框时扫码"。
     - 同时注明：该 Hook 必须写在 `apps/mobile/android/.../MainActivity`，插件 API 不能自己挂到 Activity 上（WS-C 的目录归属已覆盖，但要写清楚）。

3. **[BLOCKER] 移动端连不上 API 的两个基础问题：CORS 与内网自签证书**（01 §6、04 §1、08 §2）
   - **问题**：
     - (a) Capacitor Android 页面的 origin 是 `https://localhost`，API 在另一个域，属于跨域。文档只为 PC 写了"同域避免 CORS"，没有给移动端写 CORS 策略。
     - (b) "内网用内部 CA 并在 App 中信任"：Android 7+ 默认**不信任用户安装的 CA**。每个客户的内部 CA 都不同，也不可能打进同一个 APK。release 包在内网部署时会全部 TLS 失败。
     - (c) SSE 用的 `EventSource` 无法设置 `Authorization` 头，而移动端用的是 Bearer token。
   - **修复**：
     - (a) API 增加 CORS allowlist（`https://localhost`、`capacitor://localhost`、`http://localhost`，仅 dev 允许 Vite 端口），预检要放行 `Idempotency-Key` 和 `If-Match`。另一种做法是统一用 `CapacitorHttp`（原生请求、无 CORS），但它不覆盖 EventSource，所以两者都要写清楚。
     - (b) 提供两条路径：推荐公网域名 + Caddy DNS-01 拿正式证书；或在 `network_security_config.xml` 中 `<trust-anchors><certificates src="user"/></trust-anchors>`（仅限 API 域，或做成可配置构建变体），并在用户手册里写装 CA 的步骤。也可以考虑扫配置二维码时带上证书 SPKI 指纹做 pinning。
     - (c) SSE 改用 `fetch` + ReadableStream 的 SSE 客户端（如 `@microsoft/fetch-event-source`）带 Bearer 头，或者使用短期（60s）一次性 `?ticket=` 参数。文档需要统一这一点，并支持 `Last-Event-ID` 续传。

## MAJOR

4. **[MAJOR] 去重规则与"再扫同 SKU 累加"互相冲突**（04 §2、§2.3、§3.1）
   - **问题**：ScanHub 会丢弃 300ms 内的同文本，相机连续模式会丢弃 1.5s 内的同码。而上架状态机靠"再扫同 SKU → qty += packQty"来计数。结果是：枪快速连扫两件同品时，第二件可能被当作抖动丢掉；用相机时每件要等 1.5s，"3 秒一单"不可达。盘点"连续扫 SKU 计数"也受影响。
   - **修复**：
     - 枪源（HID/SPP）**不做时间去重**，因为枪本身一次扳机只出一帧，只过滤 <80ms 的重复帧。
     - 相机改为"条码离开取景框（连续 N 帧未检出）后才允许再次触发"，而不是固定 1.5s。
     - 相机计数场景默认改为"扫一次 + 数量键盘"，并在 UI 上明确提示。
     - 去重参数按来源配置，写进 `packages/scanner` 的单测。

5. **[MAJOR] 连续模式"扫下一个码才提交上一行"：最后一行悬空、误扫无撤销、拒绝回执滞后**（04 §3.1、00 §1 成功标准）
   - **问题**：
     - (a) 最后一行要等下一次扫码才提交，作业结束时没有提交触发。00 的"0 次额外点击、≤3 秒"无法验证。
     - (b) 误扫会被自动提交，没有撤销路径（只能找主管调整）。
     - (c) outbox 是异步的。服务端返回 422（库存不足、仓位停用、超容量）时，操作员已经扫了后面几单，只进"异常单"页的话很容易被忽略。
   - **修复**：
     - 待确认行增加 N 秒（默认 3s，可配置）空闲自动提交，并显示倒计时条。
     - 增加"撤销上一笔"大按钮，提交后 10s 内可撤。未发送时直接从 outbox 删除；已发送则生成反向交易，关联 `reversal_of`。
     - 服务端拒绝时**打断式**提示：红色全屏条 + 错误音 + 长震，必须点"知道了"才能继续扫。顶栏显示异常单计数徽标。
     - 把"扫码 → 本地落盘 → UI 成功"和"服务端确认"在 UI 上区分成两种状态（灰勾 / 绿勾）。

6. **[MAJOR] IndexedDB 作为离线账本不可靠**（04 §4、ADR-0007）
   - **问题**：Android WebView 的 IndexedDB 和 localStorage 属于浏览器存储，系统在空间不足或用户"清除缓存"时可能被清空，Capacitor 官方也不建议把关键数据放在里面。outbox 是"不丢单"承诺的唯一载体。
   - **修复**：outbox 改用 `@capacitor-community/sqlite`（或在自研插件里用 Room/SQLite 落盘）。主数据缓存可以继续用 Dexie。启动时调用 `navigator.storage.persist()` 作为附加保护。另外加一个"导出待传队列"（JSON 文件）的应急按钮。

7. **[MAJOR] 刷新令牌轮换 + 移动端并发请求，会误触发"重用检测"把操作员踢下线**（03 §2、08 §2、04 §4）
   - **问题**：移动端的 outbox 发送器、SSE、查询会同时遇到 401，并发调用 `/auth/refresh`。第二个请求拿着已作废的旧 token，被判定为"重用"，整个 family 被撤销。结果是操作员突然掉线，PENDING 单无法提交。离线几小时后恢复时，这种情况尤其容易发生。
   - **修复**：
     - 客户端 refresh 单飞（single-flight mutex）。
     - 服务端给旧 token 留 30–60s 宽限窗口：同设备返回同一个新 token，不算重用。
     - outbox 在 401 时暂停而不是失败。
     - 在离线 e2e 中加"过期后恢复联网"用例。

8. **[MAJOR] SPP 权限与 API 细节不完整**（04 §2.2）
   - **问题**：
     - (a) Android 12+ 上调用 `BluetoothAdapter.cancelDiscovery()` 需要 **`BLUETOOTH_SCAN`**，而官方建议 connect 前先调用它。只申请 `BLUETOOTH_CONNECT` 会抛 SecurityException，不调用则在系统正在扫描时连接失败率高。
     - (b) ≤ Android 11 还需要 `BLUETOOTH_ADMIN`（`maxSdkVersion=30`）。
     - (c) 反射调用 `createRfcommSocket(1)` 属于非 SDK 接口，targetSdk 36 下可能被限制。
     - (d) 运行时权限申请流程（拒绝、"不再询问"）没有设计。
   - **修复**：
     - Manifest 声明 `BLUETOOTH`/`BLUETOOTH_ADMIN`（maxSdk 30）+ `BLUETOOTH_CONNECT` + `BLUETOOTH_SCAN`（`usesPermissionFlags="neverForLocation"`）。
     - 用 Capacitor 插件的 `@Permission` 别名 + `requestPermissionForAlias` 实现，被拒时引导到系统设置。
     - `cancelDiscovery()` 只在已获得 SCAN 权限时调用，并 try/catch。
     - 反射回退加开关并记日志，真机清单标注其存在的风险。

9. **[MAJOR] SPP 重连策略与扫码枪休眠行为不匹配**（04 §2.2）
   - **问题**：多数 SPP 枪空闲 5–30 分钟会休眠断链，扳机唤醒后等待主机（平板）重连。指数退避到 30s 意味着唤醒后第一枪最多要等 30s，数据通常直接丢弃（除非枪开了存储模式）。"后台 5 分钟断开"也会让回到前台后的第一枪失败。
   - **修复**：
     - 前台时退避上限改为 3–5s。
     - 注册 `ACTION_ACL_CONNECTED`/`ACL_DISCONNECTED` 广播，枪一出现立即连接。
     - App 回到前台（`handleOnResume`）立即重连。
     - UI 在断连时于顶栏**醒目变红并发出提示音**。
     - 《扫码枪配置卡》建议关闭自动休眠或把时间调长。
     - 帧切分补充：CRLF 产生的空帧丢弃；跨 `read()` 的半帧要缓冲；缓冲上限（如 512B）防止无终止符时堆积。

10. **[MAJOR] HID 设备识别过宽、时间阈值过紧**（04 §2.1）
    - **问题**：
      - (a) `!isVirtual && SOURCE_KEYBOARD` 也会命中 gpio-keys（音量键）、平板键盘皮套、USB 键盘。全部吞掉会误伤，无法打字或调音量。
      - (b) 原生侧 50ms 空闲结束、JS 侧字符间隔 <35ms 的阈值，对**蓝牙** HID 偏紧。BT HID 报告存在批量和抖动，单字符间隔偶尔会到 60–120ms，会导致一个码被切成两半，或被判定为人工键入灌进输入框。
      - (c) `getUnicodeChar()` 需要传入 metaState，否则大写字母和 `-` 会受 Shift 影响而出错。
      - (d) 接上 HID 枪后，Android 默认**隐藏软键盘**（视为已接物理键盘），登录和搜索框无法输入。
    - **修复**：
      - 只拦截 `KEYBOARD_TYPE_ALPHABETIC` 且通过白名单（首次"测试扫码"时自动记住 descriptor 和 VID/PID）的设备，非白名单设备一律放行。只缓冲可打印字符、Enter、Tab，其余键放行。
      - 以终止符为主，空闲超时 150ms 为兜底；JS 阈值改为"平均间隔 <30ms 且最大间隔 <120ms"。
      - 使用 `event.getUnicodeChar(event.getMetaState())`。
      - 配置卡和 App 设置页提示开启"物理键盘连接时显示屏幕键盘"，或者需要文字输入时 App 调用 `InputMethodManager.showSoftInput` 强制弹出。

11. **[MAJOR] 相机连续扫描会误读相邻仓位标签**（04 §2.3）
    - **问题**：货架横梁上标签密集。ML Kit 返回的是画面中**所有**条码，"扫到即提交"会随机读到旁边仓位或 SKU 的码。这是相机方案在仓库里最常见的错账来源。
    - **修复**：
      - 用 `cornerPoints`（README 确认只有 `startScan` 提供）换算到取景框坐标，只接受中心落在瞄准框内的码。框内有多个码时取离中心最近的那个。
      - 要求连续 2 帧读到同一码才算有效。
      - `formats` 限定为 Code128/EAN-13/EAN-8/UPC-A/QR，以提速并减少误读。
      - 取景框中央画十字准星。

12. **[MAJOR] "半屏取景 + 下半屏表单"与 `startScan` 的渲染模型冲突，手电筒 API 也写错了**（04 §2.3）
    - **问题**：
      - `startScan` 把相机画在 WebView **下方**，需要 DOM 背景透明（README 的 `barcode-scanner-active` 方案）。"半屏"只能靠上半屏透明"挖洞"实现，与 antd-mobile 弹层、页面转场、3D canvas 都会冲突。相机预览仍然是全屏分辨率，比较耗电。
      - 手电筒在 v8 中需要单独装 `@capawesome/capacitor-torch`，不在本插件里。
    - **修复**：
      - 作业页布局设计成上半屏全透明区（只放瞄准框和状态），下半屏是不透明表单。进入扫码时给 `html/body/#root` 及上半区祖先节点设为透明；扫码页禁止弹出全屏 Modal。
      - 加 torch 插件依赖。
      - 在 M3 第一天做 spike，验证三种机型上的透明挖洞效果。
      - 同时声明：不使用 `scan()`、不加 `barcode_ui` meta-data（否则 GMS 机会从 Play 下载模块，也无必要）。

13. **[MAJOR] Android WebView 版本与国内无 GMS 机型的现实不符**（01 §7、04 §5、风险 R2/R3）
    - **问题**：要求 "Android System WebView ≥ 110"，但 System WebView 靠 Play 商店更新，无 GMS 的国内机型由厂商 ROM 随系统更新，常见版本更旧，华为还使用自家 WebView。WebGL2、`addUpdateRange`（three r159+ 的 API）、ES2022 语法都可能不可用。文档也没有设置 Capacitor 的 `android.minWebViewVersion`。
    - **修复**：
      - 在 `capacitor.config.ts` 设置 `android.minWebViewVersion`（建议 ≥ 99，按实测定），低于该版本时显示中文提示页。
      - 构建目标定为 `es2020`，Vite 加 legacy 检查。
      - 3D 启动前检测 WebGL2，不支持时直接走 2D。
      - 真机清单至少覆盖一台无 GMS 的国产机（华为 / 荣耀 / 小米国内版）。

14. **[MAJOR] 三角形预算与"2 万仓位流畅"的说法自相矛盾**（04 §5、06 §2/§7、ADR-0005、00 §1）
    - **问题**：Box = 12 三角形。2 万仓位仅仓位方块就有 24 万三角形。框架约 50 个盒子 × 12 = 约 600 三角形/货架，500 个货架约 30 万。合计 >50 万，远超 ≤150k 的预算。即使 5k 仓位：仓位 6 万 + 框架约 7.5 万 ≈ 13.5 万，已逼近上限。ADR 的"2 万仓位仍可在中端机流畅"没有依据，验收只覆盖 5k，而总览承诺的规模是 ≤ 2 万仓位。
    - **修复**：
      - 预算按场景分档（5k：≤150k；20k：≤300k 并启用 LOD 远景）。
      - 仓位盒去掉底面（10 三角形）。
      - 框架低模用"立柱 + 每层一根合并横梁"，最多约 200 三角形/货架。
      - 远景不画仓位，只画货架实心盒。
      - 把 20k 场景加进真机验收；ADR-0005 的说法改成"经 LOD 后"。

15. **[MAJOR] 空/有货分两个 InstancedMesh，但实时更新只改颜色**（06 §4、§6）
    - **问题**：仓位从空变有货（或反过来）时，要从透明 mesh 移到不透明 mesh。§6 写的是"只改对应 instanceColor 段"，不改变成员关系，结果会显示错误。另外，定位模式"其它仓位整体透明"会让不透明 mesh 也变透明，引入排序问题。
    - **修复**：
      - 两个 mesh 都按 N 个实例分配，用"缩放 0 / 原矩阵"切换归属（同时更新 instanceMatrix 的局部范围）。也可以改为单 mesh + 自定义 `instanceAlpha` attribute（`onBeforeCompile`），透明部分只用于空仓位并设 `depthWrite=false`。
      - 定位模式下统一把其余实例颜色混向灰色（不透明），目标实例另放到 Highlight mesh。
      - 补单测：occupancy 增量改变空 / 非空状态后，两个 mesh 的可见实例集合正确。

16. **[MAJOR] LOD 按整个 InstancedMesh 切换，且没有视锥裁剪：倾斜视角下要么全远、要么全近**（06 §7、ADR-0005）
    - **问题**：仓库 60m 长，相机靠近一端时近处和远处同时在画面里。按"整组"切换 LOD，要么近处没有仓位，要么远处也全画。单个 InstancedMesh 包围盒覆盖全仓，视锥裁剪也等于没有。
    - **修复**：直接按**巷道（或货架行）分块**，每块一组仓位 mesh 和框架 mesh，按块做距离 LOD 和视锥裁剪。20 条巷道 × 3 ≈ 60 draw calls，仍在预算内，降到 ≤ 2 万仓位时可以动态合并。LOD 判定加滞回，防止抖动。

17. **[MAJOR] twinIndex 没有和布局版本绑定**（03 §6、06 §5/§6）
    - **问题**：`/inventory/locate` 和 `/twin/occupancy?since=` 返回 twinIndex，但客户端可能缓存着旧版本的 TwinModel（离线或 ETag 缓存）。布局发布后下标会错位，3D 高亮到错误的仓位，这是数字孪生最严重的"所见非所存"。
    - **修复**：
      - 所有带 twinIndex 的响应都携带 `layoutVersion`，版本不一致时客户端丢弃并重新拉取 `/twin`，或者改为返回 `locationId`、由客户端映射。
      - `?since=` 的增量格式明确为 `{layoutVersion, asOf, changes:[{i, qty, skuCount, fill}]}`，`since` 过旧时返回 410，由客户端全量拉取。
      - SSE `stock.changed` 同时带 `layoutVersion`。

18. **[MAJOR] 2D 平面图 ↔ 3D 坐标、旋转方向、取货面与编号方向没有定义，设计器和 3D 容易镜像或转反**（02 §2、05 §2、06 §3）
    - **问题**：
      - 02 写"右手系 Y 向上、原点为平面图左下角"。从上往下看时，右手系 +Z 指向屏幕**下方**。如果平面图把 z 画成向上，3D 会是镜像。Konva 是 y 向下、旋转顺时针为正；three 的 `rotation.y` 正方向从上看是逆时针。
      - 货架基点是"左前角"，但旋转中心不明。
      - bay 和 position 的编号方向（面对取货面时从左到右？）没有定义，`face=BACK` 时是否反向也不清楚，而这直接决定标签贴在哪个物理格子上。
    - **修复**：
      - 在 02 增加"坐标与方向约定"小节：画布 (u,v) → 世界 (x = u, z = v)，Konva 不翻转，且原点改为**左上角**，与 Konva 一致；或给出明确的翻转矩阵。
      - `rotationDeg` 定义为"俯视顺时针"，three 中取 `rotation.y = -rad`；旋转中心为基点（左前角）。
      - 规定"站在巷道里、面对取货面：bay 从左到右递增、position 从左到右递增、level 自下而上"。
      - `domain.expandRack` 的单测用固定的 0/90/180/270° 和 FRONT/BACK 黄金样例，PC 2D、3D 预览、标签三处共用这套样例。

19. **[MAJOR] 条码内容不含仓库标识，跨仓扫错不可察觉；"全局命名空间"与"仓库内唯一"矛盾**（02 §3、07 §3、ADR-0008）
    - **问题**：
      - `A03-12-C02` 在每个仓库都可能存在。标签上的人眼文字印了仓库代码，但 Code128 和 QR 的内容是纯编码。操作员在 WH2 扫到从 WH1 带过来的标签，也能被正常解析。
      - 02 一方面写编码"仓库内唯一"，另一方面写条码登记"同一组织内不能出现相同字符串"，两者不一致。
      - `locations.barcode` 字段与 `code` 的关系也没有定义。
    - **修复**：
      - 定义 `locations.barcode = {warehouseCode}.{code}` 或类似形式（需要扩充字符集，或改用 `~` 作为分隔符并更新 ADR-0008），classifier 同时接受"带前缀"和"不带前缀（当前仓）"两种形式。
      - 带前缀但仓库不匹配时，报 `WRONG_WAREHOUSE` 错误并播放错误音。
      - 条码登记的唯一范围统一为"组织级，比较时含前缀"。
      - 或者单仓 MVP 明确"多仓扫错"不在范围内，并写进非目标。

20. **[MAJOR] "pdfkit 嵌入 bwip-js SVG"的技术路径不可行**（07 §1、ADR-0006、01 §1）
    - **问题**：pdfkit 没有 SVG 导入能力。按文档实现，要么偷偷栅格化（违背"矢量"和 dpi 对齐），要么再引入 svg-to-pdfkit。
    - **修复**：明确使用 bwip-js 的**自定义 drawing 接口**直接输出 pdfkit 的 `rect/path/fill` 调用（bwip-js README 有 pdfkit 可缩放条码示例）。模块宽度按 `dpi` 取整到点阵后换算成 pt。回读测试保持不变。

## MINOR

21. **[MINOR] 后台持续运行的 WebGL 和上下文丢失**（04 §1/§5、06 §5）
    - **问题**：平板横屏时 3D 与作业面板常驻。App 切到后台后 Android 会丢失 WebGL 上下文，回来就是黑屏。
    - **修复**：
      - 监听 `webglcontextlost/restored`，恢复时重建 renderer 资源（R3F 需手动处理）。
      - 3D 面板不可见时（`visibilitychange`、Tab 切换、IntersectionObserver）停止渲染。
      - 脉冲、光柱等动画只在高亮期间请求帧，并且在 N 秒后停止，以兑现"静止 ≈ 0 GPU"。

22. **[MINOR] "首 2 秒平均 FPS < 20"在 `frameloop="demand"` 下无法测量**（04 §5、06 §7）
    - **问题**：按需渲染时静止状态没有帧，FPS 无意义。
    - **修复**：改为启动时跑一次 2s 的离屏或强制连续渲染基准，测 p50 帧时间（> 50ms 时降级）。交互过程中持续采样帧时间，触发降级时提示。

23. **[MINOR] 拾取用 three-mesh-bvh / drei `<Bvh>` 加速 InstancedMesh 的说法不准**（06 §5）
    - **问题**：BVH 建在单个几何体（一个 12 三角形的盒子）上，对"N 个实例逐一测试"没有加速作用。
    - **修复**：利用仓位是货架局部坐标系 AABB 这一点，在 domain 中做"射线 → 货架 OBB → 仓位网格"的解析拾取（O(货架数)）。也可以直接暴力遍历实例，2 万实例约 1–2ms，可接受。从依赖中去掉 three-mesh-bvh。

24. **[MINOR] 近距离文字标签用 drei `<Html>` 在 WebView 里开销大**（06 §2）
    - **问题**：50 个 DOM 浮层每帧同步 transform，在中端机上会掉帧。
    - **修复**：只用 troika SDF 文本（或一张 512² 编码字符图集 + 实例化四边形），`<Html>` 只用于单个选中卡片。

25. **[MINOR] 手势冲突与触控**（06 §5、04 §1）
    - **问题**："单指旋转"与"点击选择""双击飞行"、平板双栏滚动会互相冲突。双击在部分 WebView 上还会触发缩放。
    - **修复**：
      - canvas 设置 `touch-action: none`。
      - 移动端默认"单指平移、双指缩放和旋转"（俯视为主更符合仓库查看习惯），点击判定为移动距离 <8px 且 <250ms。
      - 视口加 `user-scalable=no`。

26. **[MINOR] 音频和震动反馈应走原生**（04 §2.3、UX 规则）
    - **问题**：Capacitor 已经关闭了媒体手势限制，Web Audio 可以用，但 WebView 后台节流和音频解码会有延迟。`navigator.vibrate` 在 WebView 中表现不一致。
    - **修复**：
      - 在自研插件里提供 `feedback({type: ok|warn|error})`：`SoundPool` 预载 3 个短音，加上 `@capacitor/haptics`。
      - 同时提示：枪本身也会蜂鸣，"App 成功音"应只在**业务校验通过**后播放，用来区分"枪读到了"和"系统接受了"。

27. **[MINOR] targetSdk 36 强制 edge-to-edge**（04 §6）
    - **问题**：Android 15/16 上，状态栏和导航栏会覆盖顶部状态栏与底部大按钮，而底部恰好是"确认"主按钮和 Tab。
    - **修复**：使用 Capacitor 8 的系统栏 / insets 方案，CSS 用 `env(safe-area-inset-*)`。真机清单加"手势导航机型底部按钮可点"。

28. **[MINOR] 离线队列语义缺口**（04 §4、ADR-0007）
    - **问题**：
      - 串行发送遇到 REJECTED 后，是否继续发送后续单没有说明；依赖它的移库也会连锁失败。
      - 首次主数据同步（5 万 SKU）没有分页和进度显示。
      - `wms3d://config` 二维码可能被恶意替换成钓鱼服务器。
    - **修复**：
      - 明确"拒绝不阻塞队列，继续发送；同一仓位 + SKU 的后续单在 UI 上标记'可能受影响'"。
      - `/sync/masterdata` 按页游标拉取，显示进度，首次同步完成前禁止离线作业。
      - 扫配置二维码后显示服务器域名并要求确认；更改服务器时需要清空本地数据。

29. **[MINOR] 盘点"连续扫 SKU 计数"在相机来源上不可用；扫到 RACK 码时作业页行为未定义**（04 §3.4、§3.5）
    - **修复**：
      - 盘点页对相机来源默认"扫一次 + 数量键盘"。
      - 状态机为每个状态补全"扫到 RACK / UNKNOWN / 已停用仓位 / 其他仓库码"的转移和提示文案（表格形式），并做成组件测试。

30. **[MINOR] Code128 长度没有与标签宽度联动校验；X 维度取最小值不利于远距离扫描**（07 §2/§3）
    - **问题**：编码最长 32 字符时，Code128 约 390 模块 + 静区。按 X = 0.25mm 计算约 100mm，在 `loc-70x30` 和 `loc-60x40` 上放不下，bwip-js 只会把条码压缩到不可读。0.25mm 是 203dpi 下的最小值，平板 + 枪在 1–2m 外扫高位横梁，或手机相机扫码，都偏小。
    - **修复**：
      - 模板声明 `maxModules`，渲染前计算模块数，超长直接报错或自动降级到更宽的模板。
      - 设计器保存编码模式时校验"最长编码 ≤ 模板容量"。
      - 仓位标签默认 X = 0.375mm（203dpi 下 3 点）/ 0.338mm（300dpi 下 4 点），条高 ≥ 15mm；高位标签用 `rack-100x150` 或大 QR。

31. **[MINOR] PDF 走 Windows 驱动打热敏标签的实际坑没有写进流程**（07 §1/§4、ADR-0006）
    - **问题**：Chrome 内置 PDF 打印默认"适合纸张大小"，纸张方向自动旋转。热敏驱动的纸张尺寸要与模板一致，否则会出现每张偏移或跳页。dpi 对齐只有在 100% 缩放且驱动按标称 dpi 光栅化时才成立。
    - **修复**：
      - PDF 页面尺寸严格等于标签尺寸，一页一张。
      - 下载后用系统 PDF 阅读器打印时要求"实际大小"，并提供"校准页"（10mm 刻度 + 条码）。
      - 用户手册附 TSC / 佳博 / 斑马驱动的纸张设置截图步骤（"自定义纸张 100×50"）。
      - 70×30 等横向标签的页面方向固定写入 PDF。

32. **[MINOR] ZPL 与中文**（07 §1）
    - **问题**：ZPL 中的中文名称需要打印机内装中文字体（`^CW`）或以 `^GF` 栅格图形输出。.zpl 文件下载到 Windows 后，普通用户无法直接发送到打印机（需要 raw 打印）。
    - **修复**：
      - 明确 ZPL 模板只含 ASCII 编码和条码，中文以 `^GF` 栅格化或省略，并在开头加 `^CI28`。
      - MVP 如果不做 9100 直发或 Zebra Browser Print，建议在 M5 中把 ZPL 降级为"实验性"，否则价值不大。

33. **[MINOR] 文档间不一致（标签核对 / 补打 / 定位速度）**（07 §5 vs 10 M5、08 §1 vs 04、10 M4 vs 06）
    - **问题**：
      - 07 把"标签核对"称为 MVP 功能，10 把它列为 M5 可选。
      - 08 给 OPERATOR 授予"仓位标签补打"，但移动端没有任何打印能力，也没有蓝牙打印机方案。
      - 10 M4 的验收是"定位 ≤ 1s"，06 和 00 没有对应指标。
    - **修复**：
      - 统一标签核对的里程碑，建议放入 M4，因为它几乎只复用 3D 高亮和扫码。
      - OPERATOR 的补打改为"在移动端提交补打请求 → PC 打印队列"，或者从权限矩阵中删除。
      - 把"定位 ≤ 1s（缓存 twin 命中时）"写进 00 的成功标准。

34. **[MINOR] 布局设计器细节**（05 §2）
    - **问题**：
      - "任意角度旋转"会让巷道判定（宽度 < 1.2m）、阵列复制方向和 bay 编号（第 1 条）都复杂化。
      - 草稿每 2s 自动保存，每次 PUT 整个 LayoutDoc 并带 If-Match，容易频繁产生 412 噪声。
      - 立面视图里修改仓位"停用 / 容量"到底写草稿还是直接写 `locations`，没有说明。
    - **修复**：
      - MVP 限制为 0/90/180/270°，任意角度保留数据字段但放到后续版本。
      - 自动保存改成"空闲 2s 且有变化"才发送，412 时用本地副本做三方提示。
      - 明确"停用 / 容量"是运行时属性，直接 PATCH `/locations/:id`，不进布局版本；只有几何和编码进入布局版本。

---

## 建议的修订顺序
1. 先修 #1、#18（编码与坐标约定），它们决定 domain 的 `expandRack` 签名，是 M0 契约冻结的前置条件。
2. 再修 #2、#3、#8，它们决定 Android 原生工程骨架，M0 的 `assembleDebug` 空壳就应包含这些内容。
3. #4、#5、#6、#7、#11、#12 在 M3 开工前写进 04，并配好组件测试和 e2e 用例。
4. #14–#17 写进 06，并在 M4 第一周做真机基准。
5. #19、#20、#30 写进 07 / 02，M2 的回读测试按新参数执行。
