import { useEffect, useRef, useState } from 'react';
import { CameraAimFilter } from '@wms3d/scanner';
import { createCamera, setScannerActive, type CameraDriver } from '../native/camera.ts';
import { getServices } from '../app/services.ts';

/**
 * 相机扫码区（04 §2.3）：上半屏透明（只有瞄准框/十字准星/状态），下半屏由页面放不透明表单。
 * 进入时给 html/body/#root 加 barcode-scanner-active；禁止全屏 Modal 与转场动画；3D canvas 不同屏。
 */
export function CameraView(props: { onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [torch, setTorch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const driver = useRef<CameraDriver | null>(null);

  useEffect(() => {
    const cam = createCamera();
    driver.current = cam;
    const box = () => {
      const r = boxRef.current!.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const filter = new CameraAimFilter(box(), window.devicePixelRatio || 1);
    const onResize = () => filter.setBox(box(), window.devicePixelRatio || 1);
    window.addEventListener('resize', onResize);
    setScannerActive(true);
    cam
      .start((barcodes) => {
        const hit = filter.onEvent(barcodes, performance.now());
        if (hit)
          getServices().hub.dispatch({
            text: hit.rawValue,
            source: 'CAMERA',
            at: Date.now(),
            ...(hit.format ? { symbology: hit.format } : {}),
          });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      window.removeEventListener('resize', onResize);
      setScannerActive(false);
      void cam.stop().catch(() => undefined);
    };
  }, []);

  return (
    <div className="camera-area" data-testid="camera-area">
      <div className="camera-aim" ref={boxRef} data-testid="camera-aim">
        <div className="camera-cross-h" />
        <div className="camera-cross-v" />
      </div>
      <div className="camera-status">
        {error ? <span className="camera-error">{error}</span> : <span>对准瞄准框中心</span>}
        <button
          type="button"
          className="ui-btn ui-btn-default camera-btn"
          onClick={async () => {
            const ok = await driver.current?.setTorch(!torch);
            if (ok) setTorch(!torch);
          }}
        >
          {torch ? '关闭手电' : '手电筒'}
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-default camera-btn"
          data-testid="camera-close"
          onClick={props.onClose}
        >
          关闭相机
        </button>
      </div>
    </div>
  );
}
