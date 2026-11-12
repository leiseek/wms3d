# WS-A1-4 · 登录锁定状态存内存（无表）

- 工作流：ws-a1
- 阻塞：否
- 现状：03 §2 要求 5 次/分钟/账号+IP 限流、连续 10 次失败锁 15 分钟；schema 中没有锁定/失败计数表。服务端实现为进程内 `LoginLimiter`（`apps/api/src/modules/auth/limiter.ts`），单进程部署（ADR-0001）下有效，重启清零；失败审计按 IP+账号 1 分钟聚合写 audit_logs（action `auth.login`、result FAILED；触发锁定时 `auth.login.locked`）。
- 需求：Lead 确认接受内存方案；若需要跨重启/多实例，请在 `db/**` 增加 `login_lockouts(username citext pk, failures int, locked_until timestamptz)`，WS-A1 再切换实现（接口不变）。

---
**Lead 决定（2026-11-12 PT，contract-v1.2）**：**接受进程内方案作为 MVP**，已在 03 §2 注明：单进程部署有效、重启清零。落库的 `login_lockouts` 列为 v1.1，接口保持不变；本轮不改 schema。
