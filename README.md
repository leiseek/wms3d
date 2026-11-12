# wms3d — 3D 数字孪生 WMS（MVP）

面向中小仓库的轻量 WMS：PC 管理后台 + Android 平板（蓝牙扫码枪 HID/SPP）+ Android 手机（摄像头扫码），
支持仓位/货架设计、标签打印、扫码快速入出库，以及移动端 3D 数字孪生实时库存展示与 SKU 定位。

当前阶段：**M0a 完成（工具链 + 单仓骨架 + Android 外壳 + 隔离脚本）**；设计 v2.1（已处理 R1/R2 评审），契约待 M0b 冻结。。设计文档见 [`docs/`](docs/)：

| 文档 | 内容 |
|---|---|
| [00-overview](docs/00-overview.md) | 目标、非目标、角色、MVP 范围 |
| [01-architecture](docs/01-architecture.md) | 组件、部署、技术栈 |
| [02-domain-model](docs/02-domain-model.md) | ERD、仓位编码、库存台账 |
| [03-api](docs/03-api.md) | REST API、鉴权、幂等、错误模型 |
| [04-mobile](docs/04-mobile.md) | 平板/手机 UX、扫码抽象、离线队列 |
| [05-admin-and-layout-designer](docs/05-admin-and-layout-designer.md) | 管理后台与布局设计器 |
| [06-3d-twin](docs/06-3d-twin.md) | 3D 孪生场景、实例化、定位高亮 |
| [07-labels-printing](docs/07-labels-printing.md) | 仓位/货架标签打印 |
| [08-security-ops](docs/08-security-ops.md) | 安全、审计、备份、部署 |
| [09-testing](docs/09-testing.md) | 测试策略与演示数据 |
| [10-dev-plan](docs/10-dev-plan.md) | 里程碑与并行工作流 |
| [adr/](docs/adr/) | 架构决策记录 |
| [sources](docs/sources.md) | 调研参考资料 |
| [reviews/](docs/reviews/) | 评审意见与处理结果（R1-resolution） |
| [CHANGELOG-design](docs/CHANGELOG-design.md) | 设计版本记录 |

## 快速开始

```bash
source /opt/tools/env.sh
pnpm install
pnpm verify                 # lint + typecheck + test + build
scripts/dev-db.sh start     # 本机 PG17（127.0.0.1:55432）
pnpm dev:api                # http://127.0.0.1:4000/api/v1/health
pnpm dev:admin              # http://127.0.0.1:4010
pnpm apk:debug              # → /workspace/wms3d-artifacts/wms3d-debug-latest.apk
scripts/wt.sh create ws-a   # 工作流隔离：worktree + 数据库 + 端口
```

详见 [docs/dev-setup.md](docs/dev-setup.md)。
