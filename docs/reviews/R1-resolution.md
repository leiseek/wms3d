# R1 评审处理结果（设计 v2）

- 日期：2026-11-12（PT）· 处理人：Lead（Noa）· 对应提交：设计 v2 系列提交（见 CHANGELOG-design.md）
- 编号：**D** = `R1-domain-backend.md`（50 条），**M** = `R1-mobile-3d-labels.md`（34 条）
- 汇总：共 84 条 → **接受 77**、**部分接受 7**、**拒绝 0**。全部 9 条 BLOCKER 与 41 条 MAJOR 均已在文档中修复（部分接受项的未采纳部分均为可选建议，附理由）。

## 跨评审重叠项的统一决议
| 主题 | 涉及条目 | 统一决议 | 位置 |
|---|---|---|---|
| 仓位编码缺货架段 | D14、M1 | 巷道级连续 bay（左奇右偶，`side/bayStart`），编码 `A03-17-C02` | 02 §3.1、ADR-0008 |
| 坐标/旋转/编号方向 | M18、D19 | 原点左上、u→x/v→z 不翻转、俯视顺时针、基点=左前下角、面对取货面左→右 | 02 §2 |
| twinIndex 与布局版本 | D16、D17、M17 | locate 只回 locationId + layoutVersion；occupancy 带版本、409 LAYOUT_STALE；取消 since | 03 §5/§7、06 §6 |
| SSE 鉴权 | D28、M3c | fetch-event-source + Bearer，exp 关流，重连全量拉取，不用 query token | 03 §6 |
| 跨仓扫码/命名空间 | D18、M19 | 载荷 `WH1.code` + WRONG_WAREHOUSE + 组织级 barcode_registry | 02 §3.2 |
| 内网证书 | D35、M3b | ACME/DNS-01 推荐；内部 CA = user 锚点 + 二维码 SPKI 指纹启动校验 | 04 §1、08 §2 |
| 冲正/撤销 | D11、M5 | REVERSAL 交易；OPERATOR 本人 10 分钟内可撤销 | 02 §6.4、04 §3.1 |
| 离线 401 与刷新 | D29、M7 | single-flight + 60s 宽限 + BLOCKED_AUTH | 03 §2/§3.1 |

## 逐条处理
| ID | 级别 | 决定 | 处理说明 | 修复位置 |
|---|---|---|---|---|
| D1 | BLOCKER | 接受 | PG 安全幂等：`ON CONFLICT DO NOTHING RETURNING` + 新语句 SELECT；失败键不留痕 | 02 §6.2；03 §4.1；ADR-0003 |
| D2 | BLOCKER | 接受 | 方案 (b)：`balancesAfter` 由 `balance_after` 重建，字段改名 | 02 §6.3；03 §4.1 |
| D3 | MAJOR | 接受 | 唯一键 `(warehouse_id, idempotency_key)`；重放校验 performed_by/device_id；uuid@14 v7 | 02 §5；03 §4.1 |
| D4 | MAJOR | 接受 | JCS（RFC 8785）规范化原始请求体 + golden vectors | 03 §4.1；09 §1 |
| D5 | MAJOR | 接受 | close/publish 状态 CAS；`count-close:{taskId}`；通用 `idempotency_keys`；盘点提交整体覆盖 | 02 §5/§8/§9；03 §4.2 |
| D6 | MAJOR | 接受 | `WAITING_STOCK` 同键延迟重试 24h；心跳待同步数；异常单处理选项 | 03 §3.1；04 §5；ADR-0007 |
| D7 | BLOCKER | 接受 | 锁仓位 FOR SHARE/UPDATE，锁内校验停用/容量/混放；停用与发布 FOR UPDATE 互斥 | 02 §6.2；ADR-0003 |
| D8 | MAJOR | 接受 | `planMovements`：TRANSFER 展开、同键合并、排序；≤200 行与数量约束 | 02 §6.1 |
| D9 | MAJOR | 接受 | 锁查询带 warehouse_id；复合外键；作用域统一判定 | 02 §5/§6.2；03 §1.2 |
| D10 | BLOCKER | 接受 | 提交即对账：system_qty_at_count/variance 提交时固定；未扫计 0；delta 型调整；outbox 检查 | 02 §8；04 §3.4 |
| D11 | MAJOR | 接受 | 删 status；REVERSAL + 端点；TRUNCATE 触发器；wms_owner/wms_app 角色 | 02 §5.1/§6.4；08 §2 |
| D12 | MINOR | 接受 | FULL OUTER JOIN + COALESCE；增量对账 checkpoint + 每周全量 | 02 §6.5 |
| D13 | MINOR | 接受 | 删除 `stock_balances.version` | 02 §5 |
| D14 | BLOCKER | 接受 | 采纳方案 (a)：巷道级连续 bay、左奇右偶、`side/bayStart`、唯一性属性测试 | 02 §3.1；ADR-0008；09 §1/§4 |
| D15 | MAJOR | 部分接受 | 采纳 (a) 改码类别+二次确认+待补打清单、(b) DEFERRABLE 唯一；(c) 旧码别名表推迟到 v1.1（MVP 以补打标签解决，避免别名与登记表交互复杂化） | 02 §9；03 §5 |
| D16 | MAJOR | 接受 | locate 只返回 locationId + layoutVersion；occupancy `?layoutVersion` → 409 LAYOUT_STALE | 03 §5/§7；06 §6 |
| D17 | MAJOR | 接受 | 取消 `since`，全量 + ETag；统一 03/06 格式 | 03 §7；06 §6 |
| D18 | MAJOR | 接受 | `barcode_registry` 实体表 + advisory lock；载荷 `WH1.code`；WRONG_WAREHOUSE；删 locations.barcode | 02 §3.2；ADR-0008 |
| D19 | MAJOR | 接受 | 布局文档为唯一真相源；zones/racks 只读投影；模板按值快照；rack_types.key | 02 §4/§5；03 §5 |
| D20 | MINOR | 接受 | 删 max_weight；运行时属性只在 locations；effective_max 统一 | 02 §4 |
| D21 | MINOR | 接受 | 补 allow_mixed_sku、timezone；删 code_locked（EXISTS 推导） | 02 §3.1/§5 |
| D22 | MINOR | 接受 | code 列 `COLLATE "C"`；initdb C.UTF-8 | 02 §3.1/§5；08 §5.1 |
| D23 | MINOR | 接受 | row_version + 每仓库唯一草稿部分索引；删除“另存为新草稿” | 02 §5；05 §2.2 |
| D24 | MAJOR | 接受 | updated_at 触发器、tombstones、游标−10s 安全窗口、每日 digest | 02 §5；03 §5 |
| D25 | MINOR | 接受 | SKU 为组织级：ADMIN 或 all_warehouses MANAGER 可写 | 08 §1；03 §5 |
| D26 | MINOR | 部分接受 | 写明限制并预留 `user_warehouses.role_override`，MVP 不实现每仓库角色（范围控制） | 08 §1；02 §5；00 §2 |
| D27 | MAJOR | 接受 | 路由元数据声明 scope，统一 preHandler，失败 404，自动越权矩阵 | 03 §1.2；09 §1 |
| D28 | MAJOR | 接受 | fetch-event-source + Bearer；exp 关流；重连全量拉取；不用 query token；单实例说明 | 03 §6 |
| D29 | MAJOR | 接受 | 401 暂停/刷新/BLOCKED_AUTH；performedBy=令牌用户；403/409 语义 | 03 §3.1/§5；04 §5 |
| D30 | MINOR | 接受 | 补 devices、app/version、me/password、布局历史/草稿、批量仓位、盘点取消、流水 CSV、冲正 | 03 §5 |
| D31 | MINOR | 接受 | inv_txns.reason；原因码枚举；客户端判别联合仅四类；业务时间口径 | 02 §5/§7/§7.1；03 §5 |
| D32 | MINOR | 接受 | `urn:wms3d:error:*`；补错误码 | 03 §1/§3 |
| D33 | MINOR | 接受 | 台账类按 id desc keyset | 03 §1 |
| D34 | MAJOR | 接受 | audit_logs 加 warehouse_id/trace_id/result；同事务；失败登录聚合 | 02 §5；08 §3 |
| D35 | MAJOR | 接受 | 两条证书路径；二维码含 SPKI 指纹 + 确认；启动校验 | 04 §1；08 §2 |
| D36 | MINOR | 接受 | devices.disabled_at；JWT did；写接口校验；refresh 存储 M0b 选定 Keystore | 02 §5；03 §2；04 §4 |
| D37 | MAJOR | 部分接受 | 采纳：postgres:17(Debian)、调度方式、异地拷贝列为部署必填项 + 未配置时看板告警、恢复演练报告；部分采纳：WAL 归档为“推荐”而非默认开启（需现场外部存储，无法在交付时假设存在） | 08 §5.2/§6 |
| D38 | MINOR | 接受 | 多阶段镜像打包 admin；迁移 advisory lock；服务名统一 | 08 §5 |
| D39 | MAJOR | 接受 | 原生 systemd 路径为本机已验证交付；compose 标注未验证；M0a Docker 静态二进制 spike | 08 §5；10 M0a/M6 |
| D40 | MAJOR | 接受 | 竞态必过清单 11 项 + 连接池 + 基于模型测试 | 09 §2 |
| D41 | MINOR | 接受 | 模板库克隆；RBAC 由路由元数据生成 | 09 §3；03 §1.2 |
| D42 | MINOR | 接受 | seed 历史交易走 postTransaction | 09 §4 |
| D43 | BLOCKER | 接受 | 拆 WS-D1 设计器 / WS-D2 twin3d；3D 预览移到 M4.5；twin3d v0 第 2 天 | 10 §1/§2/§3 |
| D44 | MAJOR | 接受 | M0a(1d)/M0b(3d)，R2 评审后冻结；算法下放 WS-D1/WS-A | 10 §3 |
| D45 | MAJOR | 接受 | worktree/分库/端口偏移/共享 store/锁；api-client 归 Lead、ui 归 WS-C；lockfile 仅 Lead；契约请求 SLA | 10 §1/§6 |
| D46 | MAJOR | 接受 | 新增 M4.5 联调 2 天；M5 依赖 M1+M4.5；M6 依赖全部；MSW 自动生成；工期约 18 天 | 10 §2/§3 |
| D47 | MINOR | 接受 | antd 6.7、drizzle 0.45/kit 0.31、type-provider-zod 7 peer、React 19.3.x、three 0.187 等锁定 | 01 §1；ADR-0002 |
| D48 | MINOR | 接受 | 统一 classifyScan 与模块列表 | 01 §2/§3/§5 |
| D49 | MINOR | 接受 | fill 按 effective_max 定义并夹到 [0,1] | 02 §4；06 §4 |
| D50 | MINOR | 接受 | 60s ETag 轮询兜底；夜间任务 advisory lock + 仓库时区 | 03 §6；08 §4；02 §6.5 |
| M1 | BLOCKER | 接受 | 同 D14：巷道级 bay 编号 + 唯一性校验与单测 | 02 §3.1；ADR-0008 |
| M2 | BLOCKER | 接受 | 改为 dispatchKeyEventPreIme（FrameLayout 包 WebView，写在 MainActivity）；dispatchKeyEvent 二道防线 | 04 §2.1；ADR-0004 |
| M3 | BLOCKER | 部分接受 | 采纳 CORS allowlist、两条证书路径（含 user 锚点与指纹）、fetch-event-source；不采纳 `?ticket=` 与 Last-Event-ID 续传（重连后全量拉 occupancy 已足够，避免票据端点） | 03 §1.1/§6；04 §1 |
| M4 | MAJOR | 接受 | 按来源去重；枪源不做时间去重；相机离框再触发；相机计数用数量键盘 | 04 §2.4 |
| M5 | MAJOR | 接受 | 空闲 3s 倒计时自动提交、10s 撤销（删除/冲正）、打断式拒绝、灰/绿勾 | 04 §3.1；02 §6.4 |
| M6 | MAJOR | 接受 | outbox 改 SQLite；persist()；导出队列 | 04 §4；ADR-0007 |
| M7 | MAJOR | 接受 | single-flight + 60s 宽限窗口 + 401 暂停 + e2e | 03 §2；09 §2 |
| M8 | MAJOR | 接受 | 完整权限声明、别名请求、cancelDiscovery 条件调用、反射回退开关 | 04 §2.2 |
| M9 | MAJOR | 接受 | 前台退避上限 3s、ACL 广播、onResume 重连、断连告警、帧切分细节 | 04 §2.2 |
| M10 | MAJOR | 接受 | 白名单设备、只缓冲可打印键、metaState、150ms/JS 阈值、showSoftInput | 04 §2.1 |
| M11 | MAJOR | 接受 | cornerPoints 瞄准框 + 2 帧确认 + 格式限定 + 准星 | 04 §2.3 |
| M12 | MAJOR | 部分接受 | 采纳透明挖洞布局、torch 插件、不用 scan()/barcode_ui；“三种机型 spike”改为模拟器 spike + 真机待现场（本机无真机） | 04 §2.3；10 M3 |
| M13 | MAJOR | 部分接受 | 采纳 minWebViewVersion、es2020、WebGL2 检测、无 GMS 真机清单；不采纳 Vite legacy 插件（polyfill 体积大，以版本门槛代替） | 04 §1/§7；06 §7 |
| M14 | MAJOR | 接受 | 预算分档（5k ≤150k / 20k ≤300k）、去底面、低模框架、20k 真机验收、ADR 措辞 | 06 §3/§8；ADR-0005；00 §1 |
| M15 | MAJOR | 接受 | 双 mesh 每仓位一槽位、缩放 0 切换；定位时混灰不改透明；单测 | 06 §4 |
| M16 | MAJOR | 接受 | 按巷道分块 + 距离 LOD（滞回）+ 视锥裁剪 | 06 §2 |
| M17 | MAJOR | 部分接受 | 采纳 layoutVersion 绑定、locationId 映射、SSE 带版本；不采纳 `since` 增量 + 410（与 D17 一致改为全量 + ETag） | 03 §7；06 §6 |
| M18 | MAJOR | 接受 | 坐标/旋转/基点/编号方向约定 + 黄金样例 | 02 §2；05 §2.1 |
| M19 | MAJOR | 接受 | 载荷 `WH1.code`、WRONG_WAREHOUSE、组织级登记表、删 locations.barcode | 02 §3.2 |
| M20 | MAJOR | 接受 | bwip-js 自定义 drawing → pdfkit 矢量 | 07 §1；ADR-0006 |
| M21 | MINOR | 接受 | 不可见停渲染、上下文丢失重建、动画限时 | 04 §6；06 §7 |
| M22 | MINOR | 接受 | 启动 2s 强制基准测 p50 帧时间 | 06 §7 |
| M23 | MINOR | 接受 | 解析式拾取，去掉 three-mesh-bvh | 06 §5 |
| M24 | MINOR | 接受 | troika SDF 文本；Html 只用于单个卡片 | 06 §5 |
| M25 | MINOR | 接受 | touch-action/user-scalable、单指平移双指缩放旋转、点击判定 | 04 §6 |
| M26 | MINOR | 接受 | 原生 SoundPool + haptics；成功音在业务通过后 | 04 §2.5 |
| M27 | MINOR | 接受 | edge-to-edge insets + safe-area | 04 §1/§7 |
| M28 | MINOR | 接受 | 拒绝不阻塞；分页首同步 + 进度；二维码确认与换服清空 | 04 §1/§5；03 §5 |
| M29 | MINOR | 接受 | 相机计数用键盘；意外码转移表 + 组件测试 | 04 §2.3/§3.7 |
| M30 | MINOR | 接受 | maxModules 容量校验、X 维默认 0.375mm、条高 ≥15mm、模式保存校验 | 07 §2；02 §3.1 |
| M31 | MINOR | 接受 | 一页一张、方向固定、校准页、驱动指引 | 07 §1/§4 |
| M32 | MINOR | 接受 | ZPL 实验性，仅 ASCII + ^CI28 | 07 §1 |
| M33 | MINOR | 接受 | 标签核对放 M4.5（M4 交付组件）；补打改为请求队列；定位 ≤1s 写入 00 | 07 §4/§5；08 §1；00 §1；10 M4.5 |
| M34 | MINOR | 接受 | MVP 90° 步进；空闲有变化才保存 + 412 三方提示；运行时属性直接 PATCH | 05 §2；02 §4 |

## 未采纳部分汇总（均为部分接受）
| ID | 未采纳内容 | 理由 |
|---|---|---|
| D15 | 旧编码别名表 `location_aliases` | 推迟到 v1.1；MVP 用改码确认 + 待补打清单闭环，避免别名与条码登记表、分类器的交互复杂度 |
| D26 | 每仓库角色 | MVP 范围控制；已写明限制并预留字段 |
| D37 | WAL 归档默认开启 | 需要现场外部存储，交付时无法假设存在；改为部署必填异地拷贝 + 看板告警，WAL 为推荐项 |
| M3 | `?ticket=` 一次性票据、Last-Event-ID 续传 | fetch + Bearer 已解决鉴权；重连后全量拉 occupancy，续传无收益 |
| M12 | M3 第 1 天三款真机 spike | 本机无真机；改为模拟器 spike，真机项列入“待现场验证” |
| M13 | `@vitejs/plugin-legacy` | polyfill 体积与性能代价大；以 `minWebViewVersion` 门槛 + 中文提示页代替 |
| M17 | `since` 增量 + 410 | 与 D17 一致：全量 + ETag 更简单且无提交顺序漏更新问题 |
