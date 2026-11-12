/** 服务器配置（04 §1，D35/M28）：手输或扫配置二维码 `wms3d://config?api=…&pin=sha256/…`，确认主机名与指纹 */
export interface ServerConfig {
  api: string;
  pin: string | null;
}

const KEY = 'wms3d.server';

export function parseConfigCode(raw: string): ServerConfig | null {
  const t = raw.trim();
  if (!/^wms3d:\/\/config\?/i.test(t)) return null;
  const q = new URLSearchParams(t.slice(t.indexOf('?') + 1));
  const api = q.get('api');
  if (!api) return null;
  const norm = normalizeApi(api);
  if (!norm) return null;
  const pin = q.get('pin');
  if (pin && !pin.split(',').every((p) => /^sha256\/[A-Za-z0-9+/=]{43,44}$/.test(p.trim())))
    return null;
  return { api: norm, pin: pin || null };
}

/** 只接受 http(s)，去掉末尾 / 与 /api/v1 */
export function normalizeApi(api: string): string | null {
  try {
    const u = new URL(api.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

export function hostOf(api: string): string {
  try {
    return new URL(api).host;
  } catch {
    return api;
  }
}

export function loadServerConfig(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ServerConfig) : null;
  } catch {
    return null;
  }
}

export function saveServerConfig(c: ServerConfig | null): void {
  if (c) localStorage.setItem(KEY, JSON.stringify(c));
  else localStorage.removeItem(KEY);
}

export function deviceId(): string {
  const k = 'wms3d.deviceId';
  let id = localStorage.getItem(k);
  if (!id) {
    id = `mob-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    localStorage.setItem(k, id);
  }
  return id;
}

export interface AppSettings {
  continuous: boolean;
  countdownMs: number;
  cameraAccumulate: boolean;
  treatSoftKeyboardAsScanner: boolean;
  sppAddress: string | null;
  sppTerminator: 'CR' | 'LF' | 'CRLF' | 'ANY';
  sppCharset: 'UTF-8' | 'GBK';
  sppAutoConnect: boolean;
  allowReflectionFallback: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  continuous: true,
  countdownMs: 3000,
  cameraAccumulate: false,
  treatSoftKeyboardAsScanner: false,
  sppAddress: null,
  sppTerminator: 'ANY',
  sppCharset: 'UTF-8',
  sppAutoConnect: true,
  allowReflectionFallback: false,
};

export function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('wms3d.settings') ?? '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export function saveSettings(s: AppSettings): void {
  localStorage.setItem('wms3d.settings', JSON.stringify(s));
}
