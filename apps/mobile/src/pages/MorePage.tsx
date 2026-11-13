import { useEffect, useState } from 'react';
import { BigButton, visualize } from '@wms3d/ui';
import { clampCountdown } from '@wms3d/scanner';
import { getServices, useUi, APP_VERSION } from '../app/services.ts';
import { saveServerConfig } from '../app/config.ts';
import { isNative, Scanner, type HidStatus } from '../native/bridge.ts';
import { useScanHandler } from '../app/hooks.ts';
import { CameraView } from './CameraView.tsx';
import { CountPage } from './CountPage.tsx';

type Sub = 'menu' | 'scanner' | 'diag' | 'exceptions' | 'count';

export function MorePage(props: { active: boolean }) {
  const [sub, setSub] = useState<Sub>('menu');
  const rejectedCount = useUi((s) => s.rejectedCount);
  useEffect(() => {
    const h = () => setSub('exceptions');
    window.addEventListener('wms3d:exceptions', h);
    return () => window.removeEventListener('wms3d:exceptions', h);
  }, []);
  if (sub === 'scanner')
    return <ScannerTestPage active={props.active} onBack={() => setSub('menu')} />;
  if (sub === 'diag') return <DiagnosticsPage onBack={() => setSub('menu')} />;
  if (sub === 'exceptions') return <ExceptionsPage onBack={() => setSub('menu')} />;
  if (sub === 'count') return <CountPage active={props.active} onBack={() => setSub('menu')} />;
  return (
    <div className="page-pad" data-testid="more-page">
      <div className="menu">
        <BigButton testId="menu-count" onClick={() => setSub('count')}>
          盘点
        </BigButton>
        <BigButton
          testId="menu-label-check"
          onClick={() => useUi.setState({ tab: 'twin', labelCheck: true })}
        >
          标签核对
        </BigButton>
        <BigButton testId="menu-exceptions" onClick={() => setSub('exceptions')}>
          异常单{rejectedCount ? `（${rejectedCount}）` : ''}
        </BigButton>
        <BigButton testId="menu-scanner" onClick={() => setSub('scanner')}>
          扫码测试 / 扫码枪设置
        </BigButton>
        <BigButton testId="menu-diag" onClick={() => setSub('diag')}>
          诊断
        </BigButton>
      </div>
      <SettingsSection />
    </div>
  );
}

function SettingsSection() {
  const svc = getServices();
  const settings = useUi((s) => s.settings);
  const session = useUi((s) => s.session);
  const pending = useUi((s) => s.pending);
  const [msg, setMsg] = useState<string | null>(null);
  const exportQueue = async () => {
    const json = await svc.outbox.exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wms3d-outbox-${new Date().toISOString().replace(/[:.]/g, '')}.json`;
    a.click();
    setMsg('已导出待传队列');
  };
  return (
    <div className="settings">
      <h3>仓库</h3>
      <div className="ui-row wrap">
        {session?.user.warehouses.map((w) => (
          <BigButton
            key={w.id}
            kind={w.id === session.warehouseId ? 'primary' : 'default'}
            testId={`wh-${w.code}`}
            onClick={() => void svc.switchWarehouse(w.id)}
          >
            {w.code} {w.name}
          </BigButton>
        ))}
      </div>
      <h3>作业</h3>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.continuous}
          onChange={(e) => svc.updateSettings({ continuous: e.target.checked })}
        />
        连续模式（空闲自动提交）
      </label>
      <div className="setting">
        自动提交倒计时 {settings.countdownMs / 1000}s
        <BigButton
          onClick={() =>
            svc.updateSettings({ countdownMs: clampCountdown(settings.countdownMs - 1000) })
          }
        >
          −
        </BigButton>
        <BigButton
          onClick={() =>
            svc.updateSettings({ countdownMs: clampCountdown(settings.countdownMs + 1000) })
          }
        >
          ＋
        </BigButton>
      </div>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.cameraAccumulate}
          onChange={(e) => svc.updateSettings({ cameraAccumulate: e.target.checked })}
        />
        相机扫同 SKU 也累加数量（默认关闭，用数量键盘）
      </label>
      <h3>数据</h3>
      <div className="ui-row wrap">
        <BigButton testId="export-queue" onClick={() => void exportQueue()}>
          导出待传队列
        </BigButton>
        <BigButton
          testId="change-server"
          onClick={() => {
            if (pending > 0)
              return setMsg(`还有 ${pending} 条待传单据：请先联网同步或导出后再更换服务器`);
            saveServerConfig(null);
            localStorage.clear();
            window.location.reload();
          }}
        >
          更换服务器
        </BigButton>
        <BigButton kind="danger" testId="logout" onClick={() => void svc.logout()}>
          登出（待传单据保留，换班后继续上传）
        </BigButton>
      </div>
      {msg && <div className="hint">{msg}</div>}
      <div className="muted">
        版本 {APP_VERSION} · 设备 {svc.deviceId}
      </div>
    </div>
  );
}

function ExceptionsPage(props: { onBack: () => void }) {
  const svc = getServices();
  const entries = useUi((s) => s.entries);
  const list = entries.filter((e) => e.status === 'REJECTED');
  return (
    <div className="page-pad" data-testid="exceptions-page">
      <BigButton onClick={props.onBack}>‹ 返回</BigButton>
      <h3>异常单（{list.length}）</h3>
      {list.length === 0 && <div className="muted">没有异常单</div>}
      {list.map((e) => (
        <div key={e.id} className="exc" data-testid="exception-item">
          <div className="exc-label">{e.label}</div>
          <div className="exc-err">
            {e.lastError?.code}：{e.lastError?.message}
          </div>
          <div className="muted mono">单号 {e.id}</div>
          <div className="ui-row wrap">
            <BigButton testId="exc-retry" onClick={() => void svc.outbox.retryWithNewKey(e.id)}>
              重试（新键）
            </BigButton>
            {e.canAutoRetry && (
              <BigButton onClick={() => void svc.outbox.autoRetryLater(e.id)}>
                稍后自动重试
              </BigButton>
            )}
            <BigButton
              kind="danger"
              testId="exc-discard"
              onClick={() => void svc.outbox.discard(e.id)}
            >
              作废
            </BigButton>
          </div>
          <div className="muted">
            找主管调整：主管 ADJUST 时以单号 {e.id.slice(0, 18)}… 为 refNo
          </div>
        </div>
      ))}
    </div>
  );
}

function DiagnosticsPage(props: { onBack: () => void }) {
  const svc = getServices();
  const [hid, setHid] = useState<HidStatus | null>(null);
  const entries = useUi((s) => s.entries);
  const online = useUi((s) => s.online);
  const authBlocked = useUi((s) => s.authBlocked);
  useEffect(() => {
    void Scanner.getHidStatus().then(setHid);
  }, []);
  const byStatus = entries.reduce<Record<string, number>>(
    (m, e) => ({ ...m, [e.status]: (m[e.status] ?? 0) + 1 }),
    {},
  );
  const c = svc.hub.counters();
  return (
    <div className="page-pad" data-testid="diag-page">
      <BigButton onClick={props.onBack}>‹ 返回</BigButton>
      <h3>扫码 Hook</h3>
      <table className="tbl">
        <tbody>
          <tr>
            <td>pre-IME 拦截层</td>
            <td data-testid="diag-hook">
              {hid ? (hid.installed ? '已安装' : `未安装：${hid.installError}`) : '…'}
            </td>
          </tr>
          <tr>
            <td>拦截按键数 / 超长溢出</td>
            <td data-testid="diag-overflow">
              {hid?.interceptedKeys ?? 0} / {hid?.overflowCount ?? 0}
            </td>
          </tr>
          <tr>
            <td>白名单设备</td>
            <td>{hid?.whitelist.map((d) => d.name).join('、') || '无'}</td>
          </tr>
          <tr>
            <td>ScanHub 接受 / 丢弃</td>
            <td>
              {c.accepted} / {c.dropped}
            </td>
          </tr>
        </tbody>
      </table>
      <h3>队列与同步</h3>
      <table className="tbl">
        <tbody>
          <tr>
            <td>网络</td>
            <td>{online ? '在线' : '离线'}</td>
          </tr>
          <tr>
            <td>发送器</td>
            <td>{authBlocked ? `暂停（${authBlocked}）` : '运行'}</td>
          </tr>
          <tr>
            <td>outbox</td>
            <td data-testid="diag-outbox">{JSON.stringify(byStatus)}</td>
          </tr>
          <tr>
            <td>主数据</td>
            <td>
              {svc.md ? JSON.stringify(svc.md.counts) : '-'} · 上次同步{' '}
              {svc.md?.snap.lastSyncAt ?? '-'}
            </td>
          </tr>
        </tbody>
      </table>
      <h3>环境</h3>
      <div className="muted mono">
        {APP_VERSION} · {isNative ? 'native' : 'web'} · {navigator.userAgent}
      </div>
    </div>
  );
}

function ScannerTestPage(props: { active: boolean; onBack: () => void }) {
  const svc = getServices();
  const lastScans = useUi((s) => s.lastScans);
  const settings = useUi((s) => s.settings);
  const sppState = useUi((s) => s.sppState);
  const [devices, setDevices] = useState<{ name: string; address: string }[]>([]);
  const [camera, setCamera] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 测试页：扫码只显示，不进入作业
  useScanHandler(() => undefined, props.active);
  useEffect(() => {
    const h = Scanner.addListener('hidDeviceCaptured', (d) => setMsg(`已记录扫码枪：${d.name}`));
    return () => void h.then((x) => x.remove());
  }, []);
  return (
    <div className="page-pad" data-testid="scanner-test-page">
      {camera && <CameraView onClose={() => setCamera(false)} />}
      <BigButton onClick={props.onBack}>‹ 返回</BigButton>
      <h3>HID 键盘模式</h3>
      <div className="ui-row wrap">
        <BigButton
          testId="hid-capture"
          onClick={() => {
            void Scanner.setHidConfig({ captureNext: true });
            setMsg('请用扫码枪扫任意条码，设备将自动加入白名单');
          }}
        >
          测试扫码（记录扫码枪）
        </BigButton>
        <BigButton onClick={() => void Scanner.openHardKeyboardSettings()}>物理键盘设置</BigButton>
      </div>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.treatSoftKeyboardAsScanner}
          onChange={(e) => svc.updateSettings({ treatSoftKeyboardAsScanner: e.target.checked })}
        />
        软键盘视为白名单设备（仅 debug 包，联调用）
      </label>
      <h3>SPP 串口模式（{sppState}）</h3>
      <div className="ui-row wrap">
        <BigButton
          onClick={async () => {
            try {
              setDevices((await Scanner.listPairedDevices()).devices);
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        >
          已配对设备
        </BigButton>
        <BigButton onClick={() => void Scanner.disconnectSpp()}>断开</BigButton>
      </div>
      {devices.map((d) => (
        <BigButton
          key={d.address}
          kind={settings.sppAddress === d.address ? 'primary' : 'default'}
          onClick={() => {
            svc.updateSettings({ sppAddress: d.address });
            void Scanner.connectSpp({
              address: d.address,
              terminator: settings.sppTerminator,
              charset: settings.sppCharset,
              allowReflectionFallback: settings.allowReflectionFallback,
            });
          }}
        >
          {d.name}（{d.address}）
        </BigButton>
      ))}
      <div className="setting">
        终止符
        {(['ANY', 'CR', 'LF', 'CRLF'] as const).map((t) => (
          <BigButton
            key={t}
            kind={settings.sppTerminator === t ? 'primary' : 'default'}
            onClick={() => svc.updateSettings({ sppTerminator: t })}
          >
            {t}
          </BigButton>
        ))}
        编码
        {(['UTF-8', 'GBK'] as const).map((c) => (
          <BigButton
            key={c}
            kind={settings.sppCharset === c ? 'primary' : 'default'}
            onClick={() => svc.updateSettings({ sppCharset: c })}
          >
            {c}
          </BigButton>
        ))}
      </div>
      <label className="setting">
        <input
          type="checkbox"
          checked={settings.allowReflectionFallback}
          onChange={(e) => svc.updateSettings({ allowReflectionFallback: e.target.checked })}
        />
        允许反射回退 createRfcommSocket(1)（非 SDK 接口，兼容老枪）
      </label>
      <h3>相机</h3>
      <BigButton testId="camera-test" onClick={() => setCamera(true)}>
        打开相机测试
      </BigButton>
      {msg && <div className="hint">{msg}</div>}
      <h3>最近扫码</h3>
      <ul className="scan-log" data-testid="scan-log">
        {lastScans.map((s, i) => (
          <li key={i}>
            <span className="badge">{s.source}</span>{' '}
            <span className="mono">{visualize(s.text)}</span>{' '}
            <span className="muted">{new Date(s.at).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
