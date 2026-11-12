/** `pnpm mock`：在 PORT_API（.env.local）上启动 mock API。 */
import { startMockServer } from '../src/mock/server.ts';

const port = Number(process.env.PORT_API ?? 4000);
const latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 0);
const { url } = await startMockServer({ port, latencyMs, logger: process.env.MOCK_LOG === '1' });
console.log(
  `wms3d mock API 已启动：${url}/api/v1 （演示账号 admin/manager/op1/op2/viewer，密码 Wms3d#demo）`,
);
