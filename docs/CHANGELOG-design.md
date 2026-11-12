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
