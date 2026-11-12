import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, ConfigProvider, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createApiClient, type ApiClient } from '@wms3d/api-client';
import { LayoutDesignerPage } from '../index';

/**
 * WS-D1 开发台（不属于 admin 正式路由；WS-B 合并后从 `/layout` 挂载 LayoutDesignerPage）。
 * 连 `pnpm mock`（PORT_API）或真实 API，`?user=manager` 切换账号，`?wh=WH2` 切换仓库。
 */
const qs = new URLSearchParams(location.search);
const user = qs.get('user') ?? 'admin';
const whCode = qs.get('wh') ?? 'WH1';

function Harness() {
  const [state, setState] = useState<
    { api: ApiClient; whId: string; role: string } | { error: string } | null
  >(null);
  useEffect(() => {
    let token: string | null = null;
    const api = createApiClient({ getAccessToken: () => token });
    (async () => {
      const r = await api.r.authLogin({
        body: {
          username: user,
          password: 'Wms3d#demo',
          deviceId: `web-ws-d1-dev-${user}`,
          client: 'web',
        },
      });
      token = r.accessToken;
      const me = await api.r.me({});
      const wh = me.warehouses.find((w) => w.code === whCode) ?? me.warehouses[0];
      if (!wh) throw new Error('账号没有可访问的仓库');
      setState({ api, whId: wh.id, role: me.role });
    })().catch((e: unknown) => setState({ error: (e as Error).message }));
  }, []);
  if (!state) return <Spin style={{ margin: 48 }} />;
  if ('error' in state) return <Alert type="error" title={`登录失败：${state.error}`} />;
  return (
    <LayoutDesignerPage
      api={state.api}
      warehouseId={state.whId}
      canPublish={state.role === 'ADMIN'}
      canEdit={state.role === 'ADMIN' || state.role === 'MANAGER'}
      height="100vh"
      exposeTestHandle
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <Harness />
    </ConfigProvider>
  </StrictMode>,
);
