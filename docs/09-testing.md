# 09 · 测试策略

> v2（2026-11-12）：补关键竞态必过清单、基于模型的属性测试、模板库加速、RBAC 自动矩阵、seed 走 postTransaction、坐标黄金样例、扫码/去重单测、mesh 归属单测。

## 1. 测试金字塔
| 层 | 工具 | 范围 |
|---|---|---|
| 单元 | Vitest | `domain`：编码生成/解析、**巷道 bay 编号与唯一性（属性测试：seed 布局与随机阵列全部唯一）**、坐标黄金样例（0/90/180/270°）、planMovements（合并/排序/TRANSFER 展开）、classifyScan（前缀/WRONG_WAREHOUSE）；`scanner`：HID 判定阈值、来源去重表、SPP 帧切分（空帧、半帧、上限）；`labels`：模块数/容量；`twin3d`：空↔有货槽位归属、idToIndex |
| 契约 | Vitest | Zod 示例双向校验；**JCS request_hash golden vectors**；OpenAPI 无漂移；MSW mock 与 OpenAPI 一致 |
| 集成（API） | Vitest + `fastify.inject` + 真实 PG17 | 每端点；**RBAC/越权矩阵由路由元数据自动生成**（每个端点 × 角色 × 本仓/他仓） |
| 并发/不变量（必过） | Vitest + `pg` 连接池（`max ≥ 并发数`，否则并发测试实为串行） | 见 §2 |
| 组件 | Vitest + Testing Library | 作业状态机（含 04 §3.7 意外码表）、倒计时自动提交、撤销、打断式拒绝、数量键盘、设计器命令栈 |
| E2E Web | Playwright 1.65 + 本机 Chrome | 管理后台主流程；移动端 Web（手机/平板视口）用 web mock 插件注入 HID/SPP/相机扫码；离线 `setOffline` 后恢复不重复；**令牌过期后恢复联网**不被踢下线；并发 401 只刷新一次 |
| 3D 性能 | Playwright + Chrome | 5k/20k 场景，3 个固定机位断言 draw calls/三角形，首屏时间 |
| Android | Gradle 单测（Kotlin：HidWedgeBuffer、SPP 帧切分）、`assembleDebug`；真机清单（04 §7） |
| 标签 | PDF → pdftoppm → zxing-wasm 回读 |
| 部署 | `infra/native/install.sh --foreground` 在本机冒烟：起 PG/API/Caddy → 健康检查 → 登录 → 一笔交易 → 备份 → 恢复 → 对账 |

## 2. 关键竞态必过清单（D40）
1. 同仓位 50 并发出库不超卖。
2. 同幂等键 20 并发只记一次；不同 body 同键 409；**不同用户同键 409 且不泄露**。
3. **首请求 422 回滚后同键重放成功执行**。
4. TRANSFER 环形：A→B 与 B→A 各 20 并发，无死锁、余额守恒。
5. **布局发布（停用仓位）与入库并发**：不得出现停用仓位上有库存。
6. **容量 / 禁止混放并发入库**：不得超容、不得混放。
7. **盘点 close 双击/重试**：只生成一笔 COUNT_ADJUST。
8. **盘点提交与出库并发**：variance 与提交时刻余额一致。
9. **跨仓 locationId 越权**：404，余额不变。
10. 冲正重复：第二次 409 `TXN_ALREADY_REVERSED`。
11. 刷新令牌并发：同设备 60s 内两次 refresh 不撤销 family。
- **基于模型的测试**：fast-check `commands` + 内存模型 oracle（随机 INBOUND/OUTBOUND/TRANSFER/ADJUST/REVERSAL/重放），每步比对余额，结束跑对账。

## 3. 测试数据库
- `scripts/dev-db.sh` 启动单个 PG17 实例（端口见 10 §6），每个工作流独立数据库；集成测试先建 `wms_template`（迁移 + 角色），每个测试文件 `CREATE DATABASE t_<rand> TEMPLATE wms_template`（D41），结束删除。
- 测试以 `wms_app` 角色连接，确保权限约束生效。

## 4. 演示数据（seed）
`pnpm seed:demo`：
- 仓库 `WH1`「演示一号仓」60×40×10m；A 区重型托盘架：6 条巷道，每巷道左右各 4 个货架 × 4 列（巷道 bay 1–31 奇 / 2–32 偶）× 4 层 × 2 位 ≈ 1,536 仓位；B 区层板架 ≈ 1,800 仓位；RCV/SHP/QC 地面区。另建 `WH2`（小仓）用于跨仓用例。
- 500 SKU（中文名、合法 EAN-13、部分箱码 ×6/×12）；约 60% 仓位有货；10 个低于安全库存。
- 用户 admin/manager/op1/op2/viewer（dev 默认密码见 `.env.example`，首登强制改密）。
- **30 天历史交易全部通过 `postTransaction` 生成**（D42），完成后跑对账。
- `pnpm seed:perf --locations 20000`。

## 5. 扫码模拟
dev 面板：模拟扫码输入 + 演示条码按钮，可选 HID 序列（逐字 keydown，含 60–120ms 抖动模拟 BT HID）或 SPP 事件；可打印"演示条码表"PDF。

## 6. 本地 CI（`pnpm verify`；GitHub 接入后同配置）
`install --frozen-lockfile → lint(eslint+boundaries) → typecheck → test:unit → test:contract → test:int → build → e2e smoke → (可选) android assembleDebug`。里程碑合并到 main 前必须全绿。

## 7. 缺陷分级
P0 数据错误/越权 → 立即修复 + 回归；P1 主流程阻断；P2 体验；P3 文案。
