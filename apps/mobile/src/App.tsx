import { Capacitor } from '@capacitor/core';

/** M0a 外壳：确认 WebView 与平台。作业页面从 M3 开始。 */
export function App() {
  const platform = Capacitor.getPlatform();
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding:
          'calc(env(safe-area-inset-top) + 16px) 16px calc(env(safe-area-inset-bottom) + 16px)',
      }}
    >
      <h1 style={{ fontSize: 24 }}>wms3d 移动端</h1>
      <p style={{ fontSize: 18 }}>外壳（M0a）· 平台：{platform}</p>
      <p style={{ fontSize: 14, color: '#666' }}>UA：{navigator.userAgent}</p>
    </main>
  );
}
