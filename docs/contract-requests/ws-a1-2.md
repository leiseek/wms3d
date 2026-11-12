# WS-A1-2 · renderLabels：warehouseId 可选但 scope 取自 body.warehouseId

- 工作流：ws-a1
- 阻塞：否
- 现状：`LabelRenderRequest.warehouseId` 标注「kind=LOCATION/RACK 必填」（optional），但路由 `scope: { from: 'body', field: 'warehouseId' }`。守卫在字段缺失时一律 404，所以 kind=SKU 不带 warehouseId 也会 404；文档意图（SKU 标签无仓库）与实现不一致。
- 需求（二选一，推荐 A）：
  - A：`warehouseId: Id` 改为必填（SKU 标签也带当前仓库，用于审计/补打队列归属）。不改服务端。
  - B：scope 改为 resource/自定义：kind=SKU 时 scope none。需要 RouteRegistry 支持条件 scope（Lead 所有）。
- 另：`renderLabels.produces` 只有 `application/pdf`；服务端已接 `@wms3d/labels` 的实验 ZPL，`format=ZPL` 时返回 `application/vnd.zebra.zpl; charset=utf-8`（A4 多联模板 400）。建议 produces/文档补上 ZPL，并记录响应头 `X-Label-Count`、`X-Reprints-Done`。
