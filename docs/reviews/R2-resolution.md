# R2 评审处理记录（设计 v2.1）

- 日期：2026-11-12（PT）
- 输入：`R2-domain-backend.md`（下文前缀 **B-**）、`R2-mobile-3d-labels.md`（前缀 **M-**），两份结论都是 CHANGES-REQUIRED。
- 结果：**38 条新问题**（B 19 + M 19，含 4 对重复）：**35 条接受、3 条部分采纳、0 条拒绝**。两份评审重开的 14 条 R1 条目全部通过对应的 N 项关闭。
- **contract-v1 未冻结**：等两位评审对下表\"冻结前必须\"的条目做定向复核后再打 tag（10 §M0b）。
- 修复位置写的是 v2.1 文档的章节；涉及 M0a 脚手架的改动已经在代码里落地（见\"代码\"列）。

## 1. 重开的 R1 条目

| R1 | 来源 | 关闭依据 | 状态 |
|---|---|---|---|
| D5 盘点关闭幂等 | B | B-N4：CAS + 调整单 + `closed_txn_id` 同一事务，去掉部分成功 | 关闭（待复核） |
| D6 离线库存不足 | B | B-N5（WAITING_STOCK 只限离线单）+ B-N6（换班代交） | 关闭（待复核） |
| D17 occupancy 增量 | B | B-N2 / M-N2：内容哈希 ETag，运行时属性移入 occupancy | 关闭（待复核） |
| D24 主数据增量同步 | B | B-N7：`transaction_timeout` 30s、窗口 180s、CSV 分批 | 关闭（待复核） |
| D37 备份 | B（附条件） | 异地拷贝成为上线签字阻断项（08 §6） | 满足条件 |
| D45 多 Agent 隔离 | B | B-N8 / B-N9 / B-N10 | 关闭（待复核） |
| M1 编码 | M | M-N1 = B-N1 | 关闭（待复核） |
| M4 去重 | M | M-N5（相机事件不是逐帧） | 关闭 |
| M10 HID 文字输入 | M | M-N6（部分采纳） | 关闭 |
| M11 相机瞄准 | M | M-N5 | 关闭 |
| M12 原生验证 | M | M-N7 | 关闭（改为 M6 门禁） |
| M13 WebView 门槛 | M | M-N8（M0a 已实现） | 关闭 |
| M14 / M15 3D 预算与归属 | M | M-N4 + M-N14 | 关闭 |
| M17 实时更新 | M | M-N2 + M-N3 | 关闭（待复核） |

## 2. R2-domain-backend 新问题（B-N1…N19）

| ID | 级别 | 决议 | 修复内容 | 位置 |
|---|---|---|---|---|
| B-N1 | BLOCKER | 接受（= M-N1） | 定义巷道行进方向（水平 +X、竖直 +Z）；side 由旋转推导；L `bayStart+2i`、R `bayStart+2·(bays−1−i)`；几何一致性校验；黄金样例加\"bay1 正对 bay2\"；阵列复制沿行进方向；蛇形 pick_seq | 02 §2/§3.1、05 §2、ADR-0008 |
| B-N2 | MAJOR | 接受（= M-N2） | occupancy ETag = 内容哈希；`isActive`/`effectiveMax` 移入 occupancy；`/twin` ETag = layoutVersion；新增 SSE `locations.changed`；必过测试 12 | 03 §6/§7、06 §6、09 §2 |
| B-N3 | MAJOR | 接受 | 发布两轮匹配（layout_key → 按 code 匹配停用/待停用仓位并复用 id）；按 id 写投影；停用载荷从登记表释放；必过测试 13 | 02 §9、09 §2 |
| B-N4 | MAJOR | 接受（推荐方案） | 关闭单事务；任一行不足则整单失败、留在 REVIEW、`COUNT_RECOUNT_REQUIRED` | 02 §8、03 §4.2、ADR-0003、09 §2 |
| B-N5 | MAJOR | 接受 | WAITING_STOCK 仅 `createdOffline=true`；在线 422 立即打断 +\"稍后自动重试\"按钮 | 03 §3.1、04 §5、02 §7、ADR-0007 |
| B-N6 | MAJOR | 接受 | `device_sessions` 表；performedBy ≠ 令牌用户的接受条件（同设备、会话区间 ±5 分钟、账号启用）；允许带待传单据登出；必过测试 15 | 02 §5/§6.6、03 §5、04 §5、ADR-0007 |
| B-N7 | MAJOR | 接受 | `transaction_timeout=30s`（发布 120s）；同步安全窗口 180s；CSV 每 1000 行一个事务 | 02 §5、03 §1.3/§5、05 §3 |
| B-N8 | MAJOR | 接受 | `wms_tpl_<ws>_<迁移哈希>` + flock + IS_TEMPLATE；**`scripts/test-db.sh` 已实现并实测** | 09 §3、10 §6.2、dev-setup §4.1 |
| B-N9 | MAJOR | 接受（推荐方案） | M0b 预装全部预期依赖；新依赖走契约请求、Lead 当天合并；WS 可本地非 frozen 安装但不得提交 package.json/lockfile（check-ownership 已拦截） | 10 §1、`scripts/check-ownership.mjs` |
| B-N10 | MINOR | 接受 | 合并队列移到 `/workspace/.wms3d-queue/`（git 外，一请求一文件）；`docs/contract-requests/**` 任何 WS 可写；**N10 规则见 §4** | 10 §6.1/§6.5、dev-setup §5 |
| B-N11 | MAJOR | 接受 | WS-A 拆为 WS-A1（auth/users/devices/warehouses/layout/skus/labels）与 WS-A2（inventory/counts/sync/twin/events/audit/jobs/dashboard），A2 n=8；`apps/api/src/db/**` 冻结后归 Lead；**ws-config/wt/check-ownership 已更新** | 10 §1/§4/§6.3 |
| B-N12 | MINOR | 接受 | 计数距提交 > 5 分钟 → needs_review；只阻塞涉及该仓位的待传单据 | 02 §8、04 §3.4 |
| B-N13 | MINOR | 接受（= M-N17） | 兄弟 token（`refresh_tokens.sibling_of`），宽限期内两者都有效 | 02 §5、03 §2、09 §2 |
| B-N14 | MINOR | 接受 | `PASSWORD_CHANGE_REQUIRED` → BLOCKED_AUTH（暂停，改密后继续） | 03 §3.1、ADR-0007 |
| B-N15 | MINOR | 接受 | REVERSAL 不可再冲正；COUNT_ADJUST 仅 MANAGER；停用仓位 → LOCATION_INACTIVE；SENDING 时等待响应再冲正；必过测试 16 | 02 §6.4、ADR-0003 |
| B-N16 | MINOR | 接受 | advisory lock 统一双 int，常量在 `apps/api/src/db/locks.ts` | 02 §3.2、08 §4/§5、ADR-0003/0008 |
| B-N17 | MINOR | 接受 | 01 时序图 IndexedDB → SQLite outbox；组件图标题改为 systemd（compose 可选） | 01 §2/§5 |
| B-N18 | MINOR | 接受 | 统一 `PATCH /warehouses/:id/locations/bulk`；dev CORS 由 `.env.local` 端口生成；生产 allowlist 只留 `https://localhost` | 03 §1.1、05 §2 |
| B-N19 | MINOR | 接受（= M-N18） | 自研 `packages/api-client/src/sse.ts`（fetch 流 + eventsource-parser 4.1.3）：401 single-flight、退避 1–30s、隐藏页策略、先连流再全量拉；弃用 fetch-event-source | 03 §6、04 §1 |

## 3. R2-mobile-3d-labels 新问题（M-N1…N19）

| ID | 级别 | 决议 | 修复内容 | 位置 |
|---|---|---|---|---|
| M-N1 | BLOCKER | 接受 | 同 B-N1 | 02、05、ADR-0008 |
| M-N2 | MAJOR | 接受 | 同 B-N2 | 03、06 |
| M-N3 | MAJOR | 接受 | 服务端按仓库缓存 occupancy（事件标脏、最多每秒重算）；客户端最小间隔 2s 移动 / 1s PC、仅可见时拉取；指标\"20k 仓位、50 客户端、2 笔/秒，occupancy CPU < 20%\"进 01 §7 与 M4.5 压测 | 01 §7、03 §6、06 §6 |
| M-N4 | MAJOR | 接受 | 紧凑槽位 + `mesh.count` + swap-remove（slotOf/locOf）；层过滤用 count；断言 `opaque.count + empty.count == N_k` | 06 §2/§4、ADR-0005 |
| M-N5 | MAJOR | 接受 | 400ms 时间间隔再触发；连续 2 次事件中心在框内；cornerPoints ÷ dpr；首次识别预算约 0.5s，必要时 patch-package 降低 10-vote 阈值 | 04 §2.3、ADR-0004 |
| M-N6 | MAJOR | **部分采纳** | 采纳：应用内字母数字键盘（packages/ui）、`ACTION_HARD_KEYBOARD_SETTINGS` 快捷入口与指引、不再依赖 SHOW_FORCED。**推迟**：扫工牌登录（需要工牌体系与打印，v1.1） | 04 §2.1、ADR-0004 |
| M-N7 | MAJOR | 接受 | 取消模拟器 spike：Robolectric 测 pre-IME、JVM 单测 SPP、Playwright 截图测透明区；debug 白名单开关；D3 = web mock 视频 + 测试报告；M6 现场验证门禁 + 30 分钟验收脚本 + 兜底方案；**依赖：需要 leo 提供平板 + 扫描枪** | 04 §7、09 §5.1、10 §M3/§M6 |
| M-N8 | MAJOR | 接受 | `minHuaweiWebViewVersion`（占位待校准）、`server.errorPath` 独立 ES5 页、启动运行时特性检测；**M0a 已实现，APK 已重建** | 01 §7、04 §1、`apps/mobile` |
| M-N9 | MAJOR | **部分采纳（换方案）** | 问题成立；采用服务端 `device_sessions` 换班代交（B-N6）。**不采纳**\"设备保存每个用户的 refresh token\"：多份长期凭据扩大泄露面，且需要后台多身份切换 | 04 §5、ADR-0007 |
| M-N10 | MINOR | 接受 | 数量键盘打开时倒计时暂停；出库超量暂停自动提交 | 04 §3.1 |
| M-N11 | MINOR | 接受 | 拒绝遮罩期间的扫码丢弃并播放错误音 | 04 §3.1 |
| M-N12 | MINOR | 接受 | 先整串精确匹配登记表/缓存，再大写匹配，最后解析前缀（仅已知仓库判 WRONG_WAREHOUSE）；`locationCode` 接受载荷形式 | 02 §3.2、03 §5、ADR-0008 |
| M-N13 | MINOR | 接受 | FrameFar 每块一个 InstancedMesh；拾取遵从 LOD 与层过滤 | 06 §2、ADR-0005 |
| M-N14 | MINOR | 接受 | draw call 预算 ≤ 80；各验收机位的期望 LOD 分布 | 06 §2/§8、ADR-0005 |
| M-N15 | MINOR | 接受 | 70×30：字高 7mm + 条高 15mm；裸编码载荷选项（0.375mm，约 62mm）；maxModules 按 dpi 分列 | 07 §2 |
| M-N16 | MINOR | 接受 | 包住 `android.R.id.content` 根布局而非改 WebView 父节点（**M0a 已实现**）；`ACTION_MULTIPLE`/`getCharacters` 在 M3 处理 | 04 §2.1、`MainActivity.java` |
| M-N17 | MINOR | 接受 | 同 B-N13 | 02 §5、03 §2 |
| M-N18 | MINOR | 接受 | 同 B-N19 | 03 §6 |
| M-N19 | MINOR | **部分采纳** | 采纳：写明 SPKI 只在启动/配置时校验，补证书轮换指引。**无法执行**：\"M0a 用自签 CA 实测 WebView 是否信任用户锚点\"——本机没有设备也没有模拟器（无 KVM），改为 M6 现场验证项 | 04 §1、08 §6.1、10 §M6 |

## 4. N10 的处理（主仓开发规则）

评审发现 M0a 直接在主仓 `/workspace/wms3d`（main）开发，与 10 §6.1\"主仓不开发\"矛盾。处理方式：**修改规则，并把未来的工作移到 worktree**。

1. **M0a 记为书面的一次性例外**：当时没有并行 WS，只有 Lead 顺序工作；已写入 10 §M0a 完成记录。
2. **从 M0b 起，main 只做合并**，Lead 也不例外：Lead 的 worktree `/workspace/wms3d-wt/lead`（分支 `lead/m0b-contracts`）**已创建**，`wt.sh` 已允许创建 lead worktree。
3. 合并队列移到 git 之外的 `/workspace/.wms3d-queue/`（目录已创建）；契约/依赖请求放 `docs/contract-requests/**`，所有 WS 可写。

## 5. 冻结前需要定向复核的条目

B-N1/M-N1、B-N2/M-N2、M-N3、B-N3、B-N4、B-N5、B-N6/M-N9、B-N7、B-N8、B-N9、B-N13（schema 字段 `sibling_of`、`device_sessions`、`created_offline` 会进入 contract-v1）。复核通过后，Lead 在 lead worktree 开始 M0b，并打 `contract-v1` tag。
