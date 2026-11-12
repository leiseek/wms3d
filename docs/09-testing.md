# 09 · 测试策略

## 1. 测试金字塔
| 层 | 工具 | 范围 | 门槛 |
|---|---|---|---|
| 单元 | Vitest | `packages/domain`（编码生成/解析、布局展开与校验、扫码分类）、`packages/scanner`（HID 缓冲判定、去重、帧切分）、`packages/labels`（模板布局计算） | domain ≥ 90% 行覆盖 |
| 契约 | Vitest + Zod | contracts 示例数据双向校验；OpenAPI 生成无漂移（CI 比对 `openapi.json`） | 必过 |
| 集成（API） | Vitest + `fastify.inject` + **真实 PostgreSQL**（每个测试文件独立 schema/数据库，`scripts/dev-db.sh` 启动本机 PG17 二进制；CI 用 postgres service） | 每个模块的端点、权限、错误码 | 关键端点 100% |
| 并发/不变量 | Vitest | 50 并发出库同一仓位不超卖；相同幂等键 20 并发只记一次；不同 body 同键 409；随机交易序列（fast-check 属性测试）后 `on_hand == SUM(movements)` | 必过 |
| 组件 | Vitest + Testing Library | 作业页状态机（扫码序列 → 预期提交）、数量键盘、设计器命令栈 | |
| E2E Web | Playwright（本机已装 Chrome） | 管理后台：登录→建仓→设计布局→发布→打印 PDF→导入 SKU；移动端 Web 版（手机/平板视口）：用**模拟扫码**（web mock 插件 + 键盘注入 HID 序列）完成上架/出库/移库/盘点/定位；离线：`context.setOffline(true)` 下作业后恢复，校验不重复 | 冒烟用例每次 PR |
| 3D 性能 | Playwright + Chrome | 5k/20k 仓位场景 draw calls、三角形、首屏时间断言 | 必过 |
| Android | Gradle 单测（Kotlin 帧切分/解码）、`assembleDebug` 构建检查；真机清单测试（HID 枪、SPP 枪、相机、横竖屏、后台恢复） | 每个里程碑 |
| 标签 | 渲染 PDF → `pdftoppm` 栅格化 → `zxing-wasm` 解码回读 == 编码内容 | 每个模板 |

## 2. 演示数据（seed）
`pnpm seed:demo` 生成：
- 仓库 `WH1`「演示一号仓」60×40×10m；库区 A（重型托盘架，6 条巷道×8 货架×4 列×4 层×2 位 ≈ 1,536 仓位）、B（中型层板架 ≈ 1,800 仓位）、RCV/SHP/QC 地面区。
- 500 个 SKU（中文名称、EAN-13 合法条码，部分带 ×6/×12 箱码），约 60% 仓位有货，10 个 SKU 低于安全库存。
- 用户：`admin / manager / op1 / op2 / viewer`（开发环境默认密码在 `.env.example` 中说明，生产强制首次改密）。
- 30 天随机历史交易（生成流水 + 余额，跑对账校验）。
- 大场景：`pnpm seed:perf --locations 20000` 用于性能测试。

## 3. 扫码模拟器
- 浏览器端开发面板（仅 dev 构建）："模拟扫码"输入框 + 演示条码快捷按钮；可选择以 HID 键盘序列（逐字 keydown，10ms 间隔 + Enter）或 SPP 事件注入，测试两条链路。
- 可打印"演示条码表"PDF（仓位 + SKU），用真机枪扫屏幕/纸面验证。

## 4. CI（接入 GitHub 后启用；本地等价 `pnpm verify`）
`pnpm install --frozen-lockfile → lint (eslint+boundaries) → typecheck → test:unit → test:int (PG) → build → e2e smoke → android assembleDebug（可选 job）`。
本地 `pnpm verify` 必须在本机全绿后才提交里程碑。

## 5. 缺陷分级
P0 数据错误（库存不一致、重复记账、越权）→ 立即修复并补回归测试；P1 主流程阻断；P2 体验；P3 文案。
