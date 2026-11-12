/**
 * CORS allowlist（08 §3）。生产只放行 Capacitor 来源 https://localhost（管理端同源，无需 CORS）；
 * 开发额外放行本工作流 .env.local 的 admin/mobile Vite 端口（127.0.0.1 与 localhost）。
 */
export function corsAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = new Set<string>(['https://localhost', 'capacitor://localhost']);
  if (env.NODE_ENV !== 'production') {
    for (const key of ['PORT_ADMIN', 'PORT_MOBILE']) {
      const port = env[key];
      if (port && /^\d+$/.test(port)) {
        list.add(`http://127.0.0.1:${port}`);
        list.add(`http://localhost:${port}`);
      }
    }
  }
  for (const extra of (env.CORS_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim())) {
    if (extra) list.add(extra);
  }
  return [...list];
}
