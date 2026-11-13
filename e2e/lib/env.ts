/**
 * e2e 运行参数（docs/workstreams/ws-f.md）。ws-f 端口段：API 4700 · admin 4710 · mobile 4720 · 额外 4730–4799。
 * e2e 自己起的后端用 4730（real）/ 4731（mock），不占用开发者手动 `pnpm dev:api` / `pnpm mock` 的 4700。
 */
import { fileURLToPath } from 'node:url';

export type Target = 'mock' | 'real';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/**
 * 被测代码所在目录（apps/api、packages/api-client）。缺省为本仓库；Lead 集成预演可指向一个合并预览目录
 * （例如 `git merge-tree` + `git archive` 解出的 main+分支），e2e 用例本身仍取自本仓库。
 */
export const APP_ROOT = (process.env.E2E_APP_ROOT ?? ROOT).replace(/\/?$/, '/');
/** 运行状态/报告放在源码树之外（根 prettier/eslint 不读嵌套 .gitignore）。 */
export const STATE_DIR = (
  process.env.E2E_STATE_DIR ?? '/workspace/wms3d-artifacts/e2e/ws-f'
).replace(/\/?$/, '/');
export const STATE_FILE = `${STATE_DIR}state.json`;

export const target: Target = process.env.E2E_TARGET === 'real' ? 'real' : 'mock';
export const ports = {
  real: Number(process.env.E2E_PORT_REAL ?? 4730),
  mock: Number(process.env.E2E_PORT_MOCK ?? 4731),
  admin: Number(process.env.E2E_PORT_ADMIN ?? 4710),
  mobile: Number(process.env.E2E_PORT_MOBILE ?? 4720),
};
/** 已有后端（例如 lead 的集成环境）：设置后不再自起，只跑用例。 */
export const externalBaseUrl = process.env.E2E_BASE_URL_EXTERNAL;
export const wantUi = process.env.E2E_UI === '1';
export const WS = 'ws-f';
