import type { ApiModule } from '../types.ts';

/**
 * layout 模块（tag 'layout'，归 ws-a1）。用 routes.register(routes.<id> 的契约, handler) 实现路由；
 * 未注册的契约路由由外壳返回 501（NOT_IMPLEMENTED）。见 docs/workstreams/ws-a1.md。
 */
export const layoutModule: ApiModule = () => {
  // TODO(ws-a1)
};
