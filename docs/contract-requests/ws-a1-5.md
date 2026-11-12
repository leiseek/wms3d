# WS-A1-5 · validateLayout 增加重复 rack key / 货架编码 / 库区编码检查

- 工作流：ws-a1（建议改 packages/domain，非 WS-A1 所有）
- 阻塞：否（服务端已在 `apps/api/src/modules/layout/plan.ts#extraIssues` 补检）
- 现状：domain `validateLayout` 不检查 doc 内重复 `racks[].key`、重复 `zones[].code` 及展开后重复的货架编码；重复 key 会让发布第一轮匹配歧义，重复货架编码会撞 `racks unique(warehouse_id, code)`。
- 需求：在 domain `validateLayout` 中以 `CODE_DUPLICATE`（ERROR，rackKeys/codes 填充）报告这三类；之后服务端删除 extraIssues，前端编辑器也能即时提示。

---
**Lead 决定（2026-11-12 PT，contract-v1.2）**：**接受，进 domain 校验，由 WS-D1 实现。** `packages/domain/src/layout/**` 归 WS-D1，WS-D1 正在改 `validateLayout`（OBB/越区），Lead 不直接改，以免冲突。要求 WS-D1 在当前分支内，以 `CODE_DUPLICATE`（ERROR，填充 rackKeys/codes）报告三类重复：重复 `racks[].key`、重复 `zones[].code`、展开后重复的货架编码，并补测试。WS-D1 合并后，WS-A1 删除 `layout/plan.ts#extraIssues`，在此之前保留。已写入 ws-d1.md / ws-a1.md。
