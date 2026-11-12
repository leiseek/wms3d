import type { ApiModule } from '../types.ts';

/**
 * twin 模块（tag 'twin'，归 ws-a2）。用 routes.register(routes.<id> 的契约, handler) 实现路由；
 * 未注册的契约路由由外壳返回 501（NOT_IMPLEMENTED）。见 docs/workstreams/ws-a2.md。
 */
export const twinModule: ApiModule = () => {
  // TODO(ws-a2)
};
