# WS-A1-1 · changePassword 当前口令错误的错误码

- 工作流：ws-a1
- 阻塞：否（服务端已按建议实现）
- 现状：`routes.changePassword` 的 errors 与 mock（`packages/api-client/src/mock/handlers.ts`）在当前口令错误时返回 `UNAUTHENTICATED`(401)。api-client 对 401 会触发 refresh 重试循环，且语义上用户 access token 是有效的。
- 需求：当前口令错误返回 `400 VALIDATION_FAILED`，`errors: [{ path: 'currentPassword', message }]`；新口令与当前相同同样 400（path `newPassword`）。
- 建议 diff：`routes.ts` changePassword `errors: ['VALIDATION_FAILED']`（去掉 UNAUTHENTICATED）；mock 同步改 400。
- 服务端现状：已返回 400 VALIDATION_FAILED（`apps/api/src/modules/auth/index.ts`）。
