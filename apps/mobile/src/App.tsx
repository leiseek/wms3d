import { lazy, Suspense, useEffect } from 'react';
import { BigButton, RejectOverlay, StatusChip } from '@wms3d/ui';
import { getServices, useUi } from './app/services.ts';
import { useIsTablet } from './app/hooks.ts';
import { LoginPage } from './pages/LoginPage.tsx';
import { ServerConfigPage } from './pages/ServerConfigPage.tsx';
import { WorkPage } from './pages/WorkPage.tsx';
import { QueryPage } from './pages/QueryPage.tsx';
import { MorePage } from './pages/MorePage.tsx';

// three.js 体积大：3D Tab 首次打开时才加载（冷启动更快）
const TwinPage = lazy(() => import('./pages/TwinPage.tsx').then((m) => ({ default: m.TwinPage })));

const TABS = [
  { id: 'work', label: '作业' },
  { id: 'query', label: '查询' },
  { id: 'twin', label: '3D' },
  { id: 'more', label: '更多' },
] as const;

export function App() {
  const phase = useUi((s) => s.phase);
  const pinError = useUi((s) => s.pinError);
  const tablet = useIsTablet();
  useEffect(() => {
    document.documentElement.dataset.layout = tablet ? 'tablet' : 'phone';
  }, [tablet]);

  if (phase === 'boot') return <div className="splash">启动中…</div>;
  if (phase === 'config' || phase === 'pin-failed') return <ServerConfigPage pinError={pinError} />;
  if (phase === 'login') return <LoginPage />;
  if (phase === 'syncing') return <SyncPage />;
  return <Shell />;
}

function SyncPage() {
  const sync = useUi((s) => s.sync);
  const svc = getServices();
  const pct = sync?.total ? Math.min(100, Math.round((sync.done / sync.total) * 100)) : null;
  return (
    <div className="login" data-testid="sync-page">
      <h1>首次同步主数据</h1>
      <div className="muted">完成前不能离线作业</div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct ?? 5}%` }} />
      </div>
      <div>
        {sync?.done ?? 0}
        {sync?.total ? ` / ${sync.total}` : ''}
      </div>
      {sync?.error && (
        <>
          <div className="error">{sync.error}</div>
          <BigButton kind="primary" onClick={() => void svc.syncMasterdata(true)}>
            重试
          </BigButton>
        </>
      )}
    </div>
  );
}

function StatusBar() {
  const svc = getServices();
  const session = useUi((s) => s.session);
  const online = useUi((s) => s.online);
  const pending = useUi((s) => s.pending);
  const rejected = useUi((s) => s.rejectedCount);
  const sppState = useUi((s) => s.sppState);
  const lastScans = useUi((s) => s.lastScans);
  const hidActive = lastScans.some((s) => s.source === 'HID' && Date.now() - s.at < 60_000);
  const wh = session?.user.warehouses.find((w) => w.id === session.warehouseId);
  return (
    <header className="statusbar" data-testid="statusbar">
      <span className="sb-wh" data-testid="sb-warehouse">
        {wh?.code ?? '-'}
      </span>
      <span className="sb-user">{session?.user.displayName}</span>
      <span className="sb-chips">
        <StatusChip label="HID" tone={hidActive ? 'ok' : 'idle'} />
        <StatusChip
          label="SPP"
          tone={sppState === 'ready' ? 'ok' : sppState === 'error' ? 'error' : 'idle'}
        />
        <StatusChip
          label={online ? '在线' : '离线'}
          tone={online ? 'ok' : 'warn'}
          testId="sb-net"
        />
        <span className={`badge ${pending ? 'badge-warn' : ''}`} data-testid="sb-pending">
          待传 {pending}
        </span>
        {rejected > 0 && (
          <button
            type="button"
            className="badge badge-error"
            data-testid="sb-rejected"
            onClick={() => {
              useUi.setState({ tab: 'more' });
              setTimeout(() => window.dispatchEvent(new Event('wms3d:exceptions')), 0);
            }}
          >
            异常 {rejected}
          </button>
        )}
      </span>
      <AuthBanner onRelogin={() => void svc.logout()} />
    </header>
  );
}

function AuthBanner(props: { onRelogin: () => void }) {
  const authBlocked = useUi((s) => s.authBlocked);
  if (!authBlocked) return null;
  return (
    <div className="auth-banner" data-testid="auth-blocked">
      {authBlocked === 'PASSWORD_CHANGE_REQUIRED' ? '需要修改密码' : '登录已失效'}
      ：待传单据已暂停上传，
      <button type="button" className="link" data-testid="relogin" onClick={props.onRelogin}>
        重新登录
      </button>
    </div>
  );
}

function RejectHost() {
  const svc = getServices();
  const rejects = useUi((s) => s.rejects);
  const r = rejects[0];
  if (!r) return null;
  return (
    <RejectOverlay
      title={r.title}
      message={r.message}
      onAck={() => svc.ackReject(r.id)}
      extra={
        r.entryId && r.canAutoRetry ? (
          <BigButton
            testId="reject-auto-retry"
            onClick={() => {
              void svc.outbox.autoRetryLater(r.entryId!);
              svc.ackReject(r.id);
            }}
          >
            稍后自动重试
          </BigButton>
        ) : undefined
      }
    />
  );
}

function Shell() {
  const tab = useUi((s) => s.tab);
  return (
    <div className="shell">
      <StatusBar />
      <main className="content">
        {/* 作业页保持挂载（保留进行中的作业状态）；其他 Tab 不可见时不渲染 */}
        <div hidden={tab !== 'work'} className="tab-pane">
          <WorkPage active={tab === 'work'} />
        </div>
        {tab === 'query' && <QueryPage active />}
        {tab === 'twin' && (
          <Suspense fallback={<div className="splash">加载 3D…</div>}>
            <TwinPage active />
          </Suspense>
        )}
        {tab === 'more' && <MorePage active />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            className={`tab ${tab === t.id ? 'tab-on' : ''}`}
            onClick={() => useUi.setState({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <RejectHost />
    </div>
  );
}
