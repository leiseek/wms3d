/** 起后端（mock | real）→ 一次性登录 5 个演示账号 → 写 $E2E_STATE_DIR/state.json（缺省 /workspace/wms3d-artifacts/e2e/ws-f）；返回 teardown（停进程、删临时库）。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FullConfig } from '@playwright/test';
import { startMock, startReal, type Backend } from './lib/backend.ts';
import {
  DEMO_USERS,
  login,
  newDeviceId,
  type DemoUser,
  type E2EState,
  type SessionInfo,
} from './lib/api.ts';
import { STATE_DIR, STATE_FILE, externalBaseUrl, target } from './lib/env.ts';

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  let backend: Backend | null = null;
  let baseUrl: string;
  if (externalBaseUrl) {
    baseUrl = externalBaseUrl.replace(/\/$/, '');
  } else {
    backend = target === 'real' ? await startReal() : await startMock();
    baseUrl = backend.baseUrl;
  }
  try {
    const sessions = {} as Record<DemoUser, SessionInfo>;
    for (const u of DEMO_USERS) {
      const deviceId = newDeviceId(`e2e-${u}`);
      const r = await login(u, undefined, deviceId, baseUrl);
      if (r.status !== 200)
        throw new Error(`演示账号 ${u} 登录失败：HTTP ${r.status} ${r.text.slice(0, 200)}`);
      sessions[u] = {
        username: u,
        accessToken: r.body.accessToken,
        userId: r.body.user.id,
        role: r.body.user.role,
        deviceId,
        sessionId: r.body.session.id,
        warehouses: r.body.user.warehouses.map((w) => ({ id: w.id, code: w.code })),
      };
    }
    const st: E2EState = {
      target: backend?.target ?? target,
      baseUrl,
      db: backend?.db ?? null,
      sessions,
    };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
    process.env.E2E_BASE_URL = baseUrl;
    console.log(`[e2e] target=${st.target} baseUrl=${baseUrl}${st.db ? ` db=${st.db}` : ''}`);
  } catch (e) {
    await backend?.stop();
    throw e;
  }
  return async () => {
    await backend?.stop();
  };
}
