import { useState, type FormEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import type { Me } from '@wms3d/contracts';
import { ApiError } from '@wms3d/api-client';
import { api, deviceId, setAccessToken } from './api';

/** M0b 外壳：登录冒烟页（可由 `pnpm mock` 或真实 API 驱动）。作业页面从 M3（WS-C）开始。 */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('op1');
  const [password, setPassword] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.r.authLogin({
        body: { username, password, deviceId: deviceId(), client: 'mobile', appVersion: '0.1.0' },
      });
      setAccessToken(r.accessToken);
      setMe(await api.r.me({}));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  const big = {
    fontSize: 20,
    padding: 12,
    width: '100%',
    boxSizing: 'border-box' as const,
    marginBottom: 12,
  };
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding:
          'calc(env(safe-area-inset-top) + 16px) 16px calc(env(safe-area-inset-bottom) + 16px)',
      }}
    >
      <h1 style={{ fontSize: 24 }}>wms3d 移动端</h1>
      {me ? (
        <p data-testid="welcome" style={{ fontSize: 20 }}>
          已登录：{me.displayName}（{me.role}）· 仓库 {me.warehouses.map((w) => w.code).join('、')}
        </p>
      ) : (
        <form onSubmit={submit}>
          <input
            aria-label="用户名"
            style={big}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <input
            aria-label="密码"
            style={big}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p style={{ color: '#c0392b', fontSize: 18 }}>{error}</p>}
          <button type="submit" style={{ ...big, background: '#1677ff', color: '#fff', border: 0 }}>
            登录
          </button>
        </form>
      )}
      <p style={{ fontSize: 12, color: '#888' }}>平台：{Capacitor.getPlatform()}</p>
    </main>
  );
}
