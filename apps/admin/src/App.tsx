import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { App as AntApp, ConfigProvider, Result, Spin } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@wms3d/api-client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { onSessionExpired } from './api';
import { useSession } from './session';
import { pathAllowed } from './lib/rbac';
import { AppLayout } from './AppLayout';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const ChangePasswordPage = lazy(() => import('./pages/ChangePasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const SkusPage = lazy(() => import('./pages/SkusPage'));
const LocationsPage = lazy(() => import('./pages/LocationsPage'));
const WarehousesPage = lazy(() => import('./pages/WarehousesPage'));
const RackTypesPage = lazy(() => import('./pages/RackTypesPage'));
const StockPage = lazy(() => import('./pages/StockPage'));
const MovementsPage = lazy(() => import('./pages/MovementsPage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const AdjustPage = lazy(() => import('./pages/AdjustPage'));
const CountsPage = lazy(() => import('./pages/CountsPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const LabelsPage = lazy(() => import('./pages/LabelsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const TwinPage = lazy(() => import('./pages/TwinPage'));
// /layout：WS-D1 的 LayoutDesignerPage（独立懒加载块，含 konva）
const LayoutPage = lazy(() => import('./pages/LayoutPage'));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (n, e) =>
        n < 2 && (!(e instanceof ApiError) || e.code === 'NETWORK' || e.status >= 500),
    },
  },
});

const Loading = () => (
  <div style={{ padding: 48, textAlign: 'center' }}>
    <Spin />
  </div>
);

/** 未登录 → /login；必须改密 → /change-password；无权限路径 → 403。 */
function Guard({ children }: { children: ReactNode }) {
  const { status, me } = useSession();
  const loc = useLocation();
  if (status === 'booting') return <Loading />;
  if (status !== 'authenticated' || !me)
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!pathAllowed(me.role, loc.pathname))
    return <Result status="403" title="没有权限" subTitle="当前角色不能访问此页面" />;
  return <>{children}</>;
}

const page = (el: ReactNode) => (
  <Guard>
    <Suspense fallback={<Loading />}>{el}</Suspense>
  </Guard>
);

const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <Suspense fallback={<Loading />}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: '/change-password',
    element: (
      <Suspense fallback={<Loading />}>
        <ChangePasswordPage />
      </Suspense>
    ),
  },
  {
    element: (
      <AppLayout>
        <Outlet />
      </AppLayout>
    ),
    children: [
      { path: '/', element: page(<DashboardPage />) },
      { path: '/stock', element: page(<StockPage />) },
      { path: '/movements', element: page(<MovementsPage />) },
      { path: '/transactions', element: page(<TransactionsPage />) },
      { path: '/adjust', element: page(<AdjustPage />) },
      { path: '/counts', element: page(<CountsPage />) },
      { path: '/alerts', element: page(<AlertsPage />) },
      { path: '/twin', element: page(<TwinPage />) },
      { path: '/skus', element: page(<SkusPage />) },
      { path: '/locations', element: page(<LocationsPage />) },
      { path: '/warehouses', element: page(<WarehousesPage />) },
      { path: '/rack-types', element: page(<RackTypesPage />) },
      { path: '/layout', element: page(<LayoutPage />) },
      { path: '/labels', element: page(<LabelsPage />) },
      { path: '/users', element: page(<UsersPage />) },
      { path: '/audit', element: page(<AuditPage />) },
      { path: '*', element: <Result status="404" title="页面不存在" /> },
    ],
  },
]);

export function App() {
  const boot = useSession((s) => s.boot);
  const expire = useSession((s) => s.expire);
  useEffect(() => {
    onSessionExpired(() => {
      queryClient.clear();
      expire();
    });
    void boot();
    return () => onSessionExpired(null);
  }, [boot, expire]);
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1668dc' } }}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
