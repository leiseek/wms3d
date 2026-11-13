# 设计变更记录

## v1 · 2026-11-11（PT）
- 首版设计：总览、架构、领域模型、API、移动端、后台与布局设计器、3D 孪生、标签打印、安全运维、测试、开发计划。
- ADR-0001 ~ 0008：TS+Capacitor、Fastify+Drizzle+PG、台账+幂等、扫码抽象、three.js 实例化、服务端 PDF 标签、离线 outbox、仓位编码。
- 本机 spike：Capacitor 8 空工程 debug APK 构建成功（JDK 21 + Android SDK 36）；PG17 二进制可用。
- 状态：待独立评审（Review 轮次 R1）。

## v2 · 2026-11-12（PT）
处理 R1 两份评审共 84 条（接受 77、部分接受 7、拒绝 0；9 条 BLOCKER 全部修复），逐条见 `reviews/R1-resolution.md`。
- **编码与坐标（M0 冻结前置）**：仓位码改为巷道级连续 bay（左奇右偶，`side/bayStart`）`A03-17-C02`；货架码 `RA03-L02`；条码载荷带仓库前缀 `WH1.A03-17-C02` + WRONG_WAREHOUSE；新增坐标/旋转/基点/编号方向约定与黄金样例；删除 `face`；MVP 仅 90° 旋转。
- **库存正确性**：PG 安全幂等（ON CONFLICT DO NOTHING + 新语句 SELECT）、`(warehouse_id, key)` 作用域、JCS hash、`balancesAfter` 重建；全局锁顺序 locations→balances，容量/混放/停用锁内校验；planMovements；跨仓复合外键；REVERSAL 冲正；TRUNCATE 触发器与 DB 角色拆分；增量对账。
- **盘点**：提交即对账（variance 提交时固定）、整体覆盖、close CAS、delta 型调整。
- **结构真相源**：布局文档唯一真相源，投影只读，模板按值快照，DEFERRABLE 唯一支持改码互换，改码确认 + 待补打清单。
- **API/安全**：仓库作用域统一判定（失败 404）+ 自动越权矩阵；SSE fetch+Bearer；移动端 CORS；刷新 60s 宽限 + single-flight；离线 401/403/422 处理矩阵；设备禁用；证书两条路径（ACME / 内部 CA + SPKI 指纹）；审计同事务。
- **移动端**：HID 拦截改 `dispatchKeyEventPreIme` + 设备白名单 + 阈值修正；SPP 权限/重连/帧切分；相机瞄准框 + 双帧确认 + 透明挖洞布局 + torch 插件；按来源去重 vs 累加；连续模式空闲 3s 提交 / 10s 撤销 / 打断式拒绝；outbox 改 SQLite；minWebViewVersion、edge-to-edge、意外码转移表。
- **3D**：按巷道分块 LOD + 视锥裁剪；三角形预算分档（5k ≤150k、20k ≤300k）；空/有货双 mesh 槽位切换；解析式拾取；troika 文本；上下文丢失与降级；twin 数据绑定 layoutVersion，取消 since 增量。
- **标签**：bwip-js 自定义 drawing → pdfkit 矢量；maxModules 容量校验；X 维 0.375mm；校准页与驱动指引；ZPL 实验性；补打请求队列。
- **运维**：原生 systemd 部署为本机已验证路径，compose 交付但标注未验证；备份异地拷贝必填 + WAL 推荐；postgres:17 Debian；迁移 advisory lock。
- **版本锁定（npm 2026-11-12 核实）**：antd 6.7、React 19.3.x（react-konva 19.3.2 / R3F 9.8 约束）、drizzle-orm 0.45 / drizzle-kit 0.31、fastify 5.12 + type-provider-zod 7、three 0.187、Capacitor 8.6、TypeScript 6.0.x。
- **开发计划**：M0a/M0b 拆分（R2 评审后冻结契约）；WS-D1 设计器 / WS-D2 twin3d 拆分，3D 预览在 M4.5 接入；新增 M4.5 联调（2 天）；M5 依赖 M1+M4.5，M6 依赖全部；单机多 Agent 隔离（worktree `/workspace/wms3d-wt/<ws>`、分库、端口偏移、Gradle/性能锁、合并协议）；总工期约 18 个工作日。
- 状态：待 R2 评审。

## v2.1 · 2026-11-12（R2 修复轮）
- 处理两份 R2 评审（均为 CHANGES-REQUIRED）：38 条新问题 → **35 接受 / 3 部分采纳（M-N6、M-N9、M-N19）/ 0 拒绝**；14 条重开的 R1 条目全部关闭。详见 `reviews/R2-resolution.md`。
- **BLOCKER N1**：定义巷道行进方向（水平 +X、竖直 +Z），side 由旋转推导，右侧 `bay = bayStart + 2·(bays−1−i)`，bay 1 与 bay 2 隔巷道正对；几何一致性校验与黄金样例更新（02、05、ADR-0008）。
- 契约与数据：occupancy 内容哈希 ETag 并承载 isActive/effectiveMax，新 SSE `locations.changed`，服务端缓存 + 客户端节流；发布两轮匹配复用 location.id；盘点关闭单事务、无部分成功；`device_sessions` 换班代交；WAITING_STOCK 仅离线单；`transaction_timeout` 30s、同步窗口 180s、CSV 分批；兄弟 refresh token；冲正规则；advisory lock 双 int；分类器先精确匹配；自研 SSE 客户端；CORS 收紧。
- 移动/3D/标签：相机再触发按时间、坐标 ÷ dpr；应用内键盘；真机验证改为 M6 发布门禁（需要 leo 提供平板 + 扫描枪）；华为 WebView 门槛 + ES5 错误页；紧凑槽位实例；draw call ≤ 80；70×30 窄标版面。
- 计划与隔离：WS-A 拆为 A1/A2（n=8），`apps/api/src/db/**` 冻结后归 Lead；依赖预装 + 契约请求通道；合并队列移出 git；**M0a 在 main 开发记为一次性例外，M0b 起 Lead 在 `/workspace/wms3d-wt/lead` 开发，main 只合并**。
- M0a 已完成（10 §M0a 完成记录），其中 R2 涉及脚手架的修复（test-db.sh、A1/A2、lead worktree、content 根包裹、WebView 门槛页）已落地。
- **contract-v1 尚未冻结**：等待评审对 R2-resolution §5 所列条目做定向复核。

## v2.2 · 2026-11-12（PT）· **冻结：contract-v1**
- R3 两份定向复核均为 APPROVE-WITH-NITS（`reviews/R3-domain-backend.md` 4 MINOR、`reviews/R3-mobile-3d-labels.md` 5 MINOR），全部接受并修复，见 `reviews/R3-resolution.md`。
- **换班代交改为按会话归属**：`performerSessionId`（同设备、72h、早于当前会话、账号启用），不再依赖设备时钟；设备 ID 只取自 JWT `did`；残余风险书面接受（审计 + 交接班报表）（02 §6.6、03 §5）。
- **PG 17.11 实测**：`transaction_timeout` 在事务开始时生效，`SET LOCAL` 不能延长 → 长事务在 BEGIN 前会话级设置（`withLongTransaction`）（02、03、09 #17）。
- advisory lock 统一双 int（`LOCK_NS.BARCODE/JOB/MIGRATION/LAYOUT_PUBLISH`）；删除 10 §6.5 的 lockfile 重建残留；01 SSE 行改为 eventsource-parser；OpenAPI 输出 `packages/contracts/openapi.json`。
- 移动：errorPath 页两种文案；`index.html` 内联 ES5 检测；`wrapContentRoot` 失败记录诊断；ScanKeyBuffer 溢出丢弃到终止符。
- **M0b 交付**（10 §M0b 完成记录）：contracts（75 个端点 / 63 路径、Zod + OpenAPI）、DB schema 与迁移（0000 + 0001 约束/触发器/视图/授权）、黄金样例与测试、演示数据、契约驱动 mock（MSW + Fastify，含 SSE）、API 外壳（type-provider-zod、swagger、作用域守卫、CORS、problem+json、健康检查）、api-client；`docs/workstreams/*` 8 份工作流简报。
- 状态：**契约冻结（git tag `contract-v1`）**；之后的契约变更走 `docs/contract-requests/` 并按 contract-v1.x 递增记录。

## contract-v1.1 · 2026-11-12（PT）
- 增量（向后兼容）：`@wms3d/contracts` 导出 `LabelKind`、`LabelTemplate` 类型（WS-E-1）；`CONTRACT_VERSION` 1.1.0。无 schema、端点、数据库变化。

## contract-v1.2 · 2026-11-12（PT）
批处理契约请求 ws-a1-1…5、ws-a2-1、ws-c-1（决定写在各请求文件末尾）。
- `changePassword` 当前口令错误 / 新旧相同 → 400 `VALIDATION_FAILED`（原 401）。
- `LabelRenderRequest.warehouseId` 改为**必填**（原来可选但作用域取自它，缺省一律 404，所以没有可用的旧调用方）；`renderLabels` 增加 `alsoProduces: application/vnd.zebra.zpl`（RouteSpec 新字段 `alsoProduces`，OpenAPI 列出两种内容类型）；A4 + ZPL 400；响应头 `X-Label-Count` / `X-Reprints-Done`。
- `SyncDigest.hash` 算法写入契约描述（sha256，客户端可复算）。
- mock：标签模板照抄 `@wms3d/labels`；ZPL 输出；改密 400；OPERATOR 冲正违规 → 403 `FORBIDDEN`；盘点关闭改为 delta 型并补齐“余额不足 → 422 `COUNT_RECOUNT_REQUIRED` + needs_review”；digest 同算法。
- 脚本：`apps/api` `db:seed:stock`；`pnpm db:reset:dev` 末尾写演示库存（`WMS_SEED_STOCK=0` 跳过）；`apps/mobile` `e2e`。
- 登录锁定 MVP 用进程内实现（03 §2 已注明），落库版本排到 v1.1。
- 联合验收 #5（布局发布停用 × 入库并发）：`apps/api/src/test/joint-5.test.ts`，在 main 上通过。
- `CONTRACT_VERSION` 1.2.0。

## contract-v1.3 · 2026-11-13（PT）
- 批处理 ws-b-1（含 B-2、B-3）与 ws-f-1。新增（向后兼容）：`Txn.performedByName/submittedByName`、`Movement.performedByName`、`AuditLog.userName`（可选）；`importSkus` 写明 multipart 字段 `file`。`CONTRACT_VERSION` 1.3.0。
- mock：解析 SKU 导入 CSV（预检错误行 / 提交写入）；Fastify mock 支持 multipart；返回显示名。
- 根脚本 `verify:full`、`ci`、`e2e`、`seed:demo`、`backup:drill`；正式 CLI `apps/api` `admin:create`（ADMIN + 首登改密 + 同事务审计）。
- 文档：布局**发布仅 ADMIN**（05 补充；ws-b 简报笔误已更正）。`balances.csv` 排到 M4.5。
