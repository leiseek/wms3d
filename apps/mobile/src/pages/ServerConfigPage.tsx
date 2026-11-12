import { useState } from 'react';
import { AppKeyboard, BigButton } from '@wms3d/ui';
import {
  hostOf,
  normalizeApi,
  parseConfigCode,
  saveServerConfig,
  type ServerConfig,
} from '../app/config.ts';
import { useScanHandler } from '../app/hooks.ts';
import { Scanner } from '../native/bridge.ts';

/** 服务器配置（04 §1）：手输或扫配置码；显示主机名与证书指纹，用户确认后保存；SPKI 在此时与每次启动时校验 */
export function ServerConfigPage(props: { pinError?: string | null }) {
  const [api, setApi] = useState('');
  const [pin, setPin] = useState('');
  const [focus, setFocus] = useState<'api' | 'pin' | null>(null);
  const [candidate, setCandidate] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(props.pinError ?? null);
  const [checking, setChecking] = useState(false);

  useScanHandler((e) => {
    const c = parseConfigCode(e.text);
    if (c) setCandidate(c);
    else setError('不是有效的配置码（wms3d://config?api=…&pin=sha256/…）');
  });

  const confirm = async (c: ServerConfig) => {
    setChecking(true);
    setError(null);
    try {
      if (c.pin) {
        const r = await Scanner.verifyServerPin({ url: `${c.api}/api/v1/health`, pin: c.pin });
        if (!r.ok) {
          setError(
            `证书指纹校验失败：${r.reason ?? ''}${r.serverPins ? `（服务器：${r.serverPins.join(', ')}）` : ''}`,
          );
          return;
        }
      }
      saveServerConfig(c);
      window.location.reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="login" data-testid="server-config">
      <h1>配置服务器</h1>
      {props.pinError && (
        <div className="error">启动校验失败：{props.pinError}（证书已变更？请扫新的配置码）</div>
      )}
      <div className="muted">扫描管理员提供的配置二维码，或手动输入</div>
      <input
        className="field"
        inputMode="none"
        placeholder="https://wms.example.com"
        value={api}
        onFocus={() => setFocus('api')}
        onChange={(e) => setApi(e.target.value)}
      />
      <input
        className="field"
        inputMode="none"
        placeholder="证书指纹 sha256/…（真实域名证书可留空）"
        value={pin}
        onFocus={() => setFocus('pin')}
        onChange={(e) => setPin(e.target.value)}
      />
      <BigButton
        kind="primary"
        onClick={() => {
          const a = normalizeApi(api);
          if (!a) return setError('地址无效');
          setCandidate({ api: a, pin: pin.trim() || null });
        }}
      >
        下一步
      </BigButton>
      {error && <div className="error">{error}</div>}
      {candidate && (
        <div className="confirm-box" data-testid="server-confirm">
          <div>
            主机：<b>{hostOf(candidate.api)}</b>
          </div>
          <div className="mono">指纹：{candidate.pin ?? '（未提供：依赖系统证书信任）'}</div>
          {candidate.api.startsWith('http:') && (
            <div className="error">明文 http：仅 debug 包允许</div>
          )}
          <div className="ui-row">
            <BigButton onClick={() => setCandidate(null)}>取消</BigButton>
            <BigButton kind="primary" disabled={checking} onClick={() => void confirm(candidate)}>
              {checking ? '校验中…' : '确认并保存'}
            </BigButton>
          </div>
        </div>
      )}
      {focus && (
        <AppKeyboard
          value={focus === 'api' ? api : pin}
          maxLen={200}
          onChange={focus === 'api' ? setApi : setPin}
          onOk={() => setFocus(null)}
        />
      )}
    </div>
  );
}
