# ADR-0007 · 移动端离线：SQLite outbox + 客户端幂等键 + 服务端裁决（v2）
- 状态：已接受 · **v2 2026-11-12**（按 R1 D6/D29/M5/M6/M7/M28 修订） · **v2.1**（2026-11-12 按 R2 B-N5/B-N6/M-N9/B-N12/B-N14 补充）

## 决策
- outbox 存 **SQLite**（`@capacitor-community/sqlite`，App 私有目录），不放 IndexedDB（WebView 存储可被回收/清缓存）；主数据缓存仍用 Dexie；提供"导出待传队列"应急。
- 确认即生成 UUIDv7（`uuid@14`，crypto 随机）→ 先落盘 → 串行发送。
- 响应矩阵：网络/5xx/429 退避重试；401 暂停 + single-flight 刷新，失败 → `BLOCKED_AUTH`（原操作员重登）；`INSUFFICIENT_STOCK` → `WAITING_STOCK`（同键 2 分钟重试，最长 24h）；其他业务 4xx → `REJECTED`（打断式提示 + 异常单），**不阻塞队列**。
- 服务端要求 `performedBy == 令牌用户`，离线单不能由他人代交。
- 连续模式：空闲 3s 自动提交、10s 内撤销（未发送删除 / 已发送冲正）。
- 设备心跳上报待传条数；盘点提交与关闭前检查待同步。
- 不做客户端冲突合并：库存强一致，由服务端原子校验裁决。

## 后果
+ 不丢单、不重复、跨设备乱序不产生大量假异常单。− 引入 SQLite 插件依赖；离线出库仍可能最终被拒（有闭环）。

## v2.1 补充（R2）
- `WAITING_STOCK` **只适用于 `createdOffline=true`** 的单据；在线单据库存不足立即打断（B-N5）。
- **换班代交**取代"原操作员重登"：A 可带着待传单据登出，B 登录后用 B 的令牌继续发送，服务端按 `device_sessions` 校验 performedBy（B-N6/M-N9）。不采纳"设备保存每个用户的 refresh token"。
- `BLOCKED_AUTH` 仅在设备上无有效登录或当前用户需改密（`PASSWORD_CHANGE_REQUIRED`）时出现（B-N14）。
- 登出不再要求 outbox 为空；盘点提交只阻塞涉及该仓位的待传单据（B-N12）。
