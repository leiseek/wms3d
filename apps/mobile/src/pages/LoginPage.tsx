import { useState } from 'react';
import { ApiError } from '@wms3d/api-client';
import { AppKeyboard, BigButton } from '@wms3d/ui';
import { getServices, useUi } from '../app/services.ts';
import { hostOf } from '../app/config.ts';

/** 登录（client='mobile'）：输入用应用内键盘（inputMode=none，不依赖系统软键盘，04 §2.1） */
export function LoginPage() {
  const svc = getServices();
  const pending = useUi((s) => s.pending);
  const authBlocked = useUi((s) => s.authBlocked);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [focus, setFocus] = useState<'u' | 'p' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await svc.login(username.trim(), password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login" data-testid="login-page">
      <h1>wms3d 仓储作业</h1>
      <div className="muted">服务器：{svc.server ? hostOf(svc.server.api) : '同源（调试）'}</div>
      {pending > 0 && (
        <div className="hint" data-testid="login-pending">
          本机有 {pending} 条待传单据{authBlocked ? '（登录失效已暂停）' : ''}
          ：任意操作员登录后继续上传（换班代交）
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="用户名"
          data-testid="login-username"
          className="field"
          inputMode="none"
          autoComplete="username"
          placeholder="用户名"
          value={username}
          onFocus={() => setFocus('u')}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          aria-label="密码"
          data-testid="login-password"
          className="field"
          type="password"
          inputMode="none"
          autoComplete="current-password"
          placeholder="密码"
          value={password}
          onFocus={() => setFocus('p')}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <div className="error" data-testid="login-error">
            {error}
          </div>
        )}
        <BigButton
          kind="primary"
          testId="login-submit"
          disabled={busy || !username || !password}
          onClick={() => void submit()}
        >
          {busy ? '登录中…' : '登录'}
        </BigButton>
      </form>
      {focus && (
        <AppKeyboard
          value={focus === 'u' ? username : password}
          onChange={focus === 'u' ? setUsername : setPassword}
          onOk={() => (focus === 'u' ? setFocus('p') : void submit())}
        />
      )}
    </div>
  );
}
