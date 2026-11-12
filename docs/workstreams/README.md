# 工作流总览（并行阶段，contract-v1）

| WS | 简报 | worktree | 分支 | API/admin/mobile | DB | 现在可开工 |
|---|---|---|---|---|---|---|
| ws-a1 | [ws-a1.md](ws-a1.md) | `/workspace/wms3d-wt/ws-a1` | `ws/ws-a1/m1-auth-layout` | 4100/4110/4120 | `wms_ws_a1` | 是 |
| ws-a2 | [ws-a2.md](ws-a2.md) | `/workspace/wms3d-wt/ws-a2` | `ws/ws-a2/m1-inventory` | 4800/4810/4820 | `wms_ws_a2` | 是 |
| ws-b | [ws-b.md](ws-b.md) | `/workspace/wms3d-wt/ws-b` | `ws/ws-b/m2-admin` | 4200/4210/4220 | `wms_ws_b` | 是 |
| ws-c | [ws-c.md](ws-c.md) | `/workspace/wms3d-wt/ws-c` | `ws/ws-c/m3-mobile` | 4300/4310/4320 | `wms_ws_c` | 是 |
| ws-d1 | [ws-d1.md](ws-d1.md) | `/workspace/wms3d-wt/ws-d1` | `ws/ws-d1/m2d-designer` | 4400/4410/4420 | `wms_ws_d1` | 是 |
| ws-d2 | [ws-d2.md](ws-d2.md) | `/workspace/wms3d-wt/ws-d2` | `ws/ws-d2/m4-twin3d` | 4500/4510/4520 | `wms_ws_d2` | 是 |
| ws-e | [ws-e.md](ws-e.md) | `/workspace/wms3d-wt/ws-e` | `ws/ws-e/m2-labels` | 4600/4610/4620 | `wms_ws_e` | 是 |
| ws-f | [ws-f.md](ws-f.md) | `/workspace/wms3d-wt/ws-f` | `ws/ws-f/m1-qa-infra` | 4700/4710/4720 | `wms_ws_f` | 是 |

- 契约已冻结、mock 覆盖全部 75 个端点，前端/3D/标签不必等后端：**8 个 WS 全部可立即并行**。
- 跨 WS 依赖（用 shim/mock 先行，合并后切换）：A1 标签端点 ← WS-E 库；WS-B `/layout` ← WS-D1 `LayoutDesignerPage`；WS-B/C/D1 的 3D ← WS-D2 v0（第 2 天）；A1 真实 verifier ← A2 测试可先注入；A2 演示库存 → B/C/D2 联调（M4.5）。
- Lead：评审、契约请求批处理（11:00/17:00 PT）、合并队列 `/workspace/.wms3d-queue/`、mock 维护。
