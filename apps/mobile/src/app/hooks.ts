import { useEffect, useRef } from 'react';
import type { ScanEvent } from '@wms3d/scanner';
import { getServices } from './services.ts';

/** 当前页面接收扫码（同一时刻只有一个页面处理器生效）；处理串行化，避免异步解析乱序 */
export function useScanHandler(
  handler: (e: ScanEvent) => Promise<void> | void,
  active = true,
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    let chain = Promise.resolve();
    return getServices().setScanHandler((e) => {
      chain = chain.then(() => ref.current(e)).catch((err) => console.error('[scan]', err));
    });
  }, [active]);
}

export function useIsTablet(): boolean {
  const m = () => Math.min(window.innerWidth, window.innerHeight) >= 600;
  const ref = useRef(m());
  ref.current = m();
  return ref.current;
}
