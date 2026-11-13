# e2e（ws-f）

Playwright 1.65 + 本机 Chrome（`/opt/google/chrome/chrome`），`workers=2`（共享机器）。只经 HTTP 访问 API（09 §1）。

```bash
bash scripts/e2e.sh                 # 对契约 mock（端口 4731）
bash scripts/e2e.sh real            # 真实 apps/api（端口 4730）+ 从 ws-f 模板克隆的一次性库（结束删除）
bash scripts/e2e.sh real --ui       # 另起 admin(4710)/mobile(4720) Vite，跑浏览器冒烟（桌面 Chrome / Pixel 7 视口）
bash scripts/e2e.sh real --app-root /tmp/preview   # 被测代码取自合并预览目录（Lead 集成预演），用例取自本仓库
E2E_DB=wms_ws_f bash scripts/e2e.sh real           # 改用本 WS 开发库（不删）
```

| 文件 | 内容 |
|---|---|
| `global-setup.ts` | 起后端、一次性登录 5 个演示账号（避开 5 次/分钟登录限流）、写 `/workspace/wms3d-artifacts/e2e/ws-f/state.json`（`E2E_STATE_DIR` 可改）；teardown 停进程、删库 |
| `tests/api/health.spec.ts` | health/ready/401/安全头 |
| `tests/api/inbound.spec.ts` | **验收：登录 + 一笔入库**；同键重放、不同 body 同键 409、跨仓 404 |
| `tests/api/demo-flow.spec.ts` | 演示脚本：建仓 → 设计（If-Match/412）→ 发布（MANAGER 403）→ 标签 PDF → SKU 导入 → 上架（离线+在线）→ 定位 → 出库（超量 422） |
| `tests/api/rbac.spec.ts` | 由 `routeList` 元数据生成的 RBAC/越权矩阵：无 token 401、角色不符 403、允许角色非 401/403、仅授权 WH1 的账号访问 WH2 → 404 |
| `tests/ui/*.spec.ts` | admin / mobile 登录冒烟（`E2E_UI=1`） |

真实 API 尚未实现的端点返回 501：相关用例显式 `skip` 并写明原因（报告可见），不会误报通过。
mock 不解析 multipart：demo-flow 的导入步骤在 mock 上改用 `POST /skus`。
