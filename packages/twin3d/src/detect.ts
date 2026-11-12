/** 启动检测 WebGL2（06 §7）。SSR / 无 DOM 环境返回 false。结果缓存。 */
let cached: boolean | undefined;
export function detectWebGL2(force = false): boolean {
  if (cached !== undefined && !force) return cached;
  try {
    if (typeof document === 'undefined') return (cached = false);
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    cached = !!gl;
    (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}
