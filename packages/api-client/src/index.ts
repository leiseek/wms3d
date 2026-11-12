/**
 * @wms3d/api-client — 由 @wms3d/contracts 驱动的类型化客户端 + SSE。
 * Mock：`@wms3d/api-client/mock`（core + MSW handlers）、`@wms3d/api-client/mock-server`（Fastify，`pnpm mock`）。
 */
export const PACKAGE_NAME = '@wms3d/api-client' as const;
export {
  ApiError,
  buildPath,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type CallArgs,
  type CallResult,
} from './client.ts';
export { connectEvents, type EventStreamOptions } from './sse.ts';
export { newIdempotencyKey } from './idempotency.ts';
