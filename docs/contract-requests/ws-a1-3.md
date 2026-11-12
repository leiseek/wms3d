# WS-A1-3 · mock 标签模板与 @wms3d/labels 不一致

- 工作流：ws-a1
- 阻塞：否（真实 API 已以 `@wms3d/labels` 为准）
- 现状：`packages/api-client/src/mock/handlers.ts` 的 LABEL_TEMPLATES 中 `maxModules` 为 33/49、25/37 等（看起来是字符数），A4 模板为 null；`a4-2x7.kinds` 含 RACK。`@wms3d/labels`（07 §2）为 loc-100x50 253/281、loc-60x40 230、loc-70x30 264/259、a4-3x8 270、a4-2x7 290、sku-60x40 230、rack-100x150 null；RACK 只允许 `rack-100x150`。
- 需求：mock 直接从 `@wms3d/labels` 的 `labelTemplates` 映射（或照抄数值），避免前端按 mock 做容量提示时与服务端 400 不一致。
