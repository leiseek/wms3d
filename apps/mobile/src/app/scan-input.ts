import { JsHidDetector, ManualScanner, type ScanHub } from '@wms3d/scanner';
import { Scanner } from '../native/bridge.ts';

/**
 * 扫码来源接入 ScanHub：
 * - HID（原生）：MainActivity pre-IME → HidRouter → 插件事件 hidScan。
 * - HID（JS 兜底）：window keydown 节奏判定（PC 浏览器 USB 枪、未白名单设备、web 调试/e2e）。
 *   焦点在可编辑元素时只判定不拦截（人工输入照常）；作业页无可编辑焦点。
 * - SPP：插件事件 sppScan。
 */
export function attachScanSources(hub: ScanHub): () => void {
  const hid = new ManualScanner('HID');
  const spp = new ManualScanner('SPP');
  hub.register(hid);
  hub.register(spp);
  hid.setStatus('ready');
  const subs: Promise<{ remove: () => Promise<void> }>[] = [
    Scanner.addListener('hidScan', (e) => hid.push(e.text, Date.now(), { deviceKey: e.deviceKey })),
    Scanner.addListener('sppScan', (e) => spp.push(e.text, Date.now(), { deviceKey: e.deviceKey })),
    Scanner.addListener('sppState', (e) =>
      spp.setStatus(
        e.state === 'ready'
          ? 'ready'
          : e.state === 'connecting'
            ? 'connecting'
            : e.state === 'error'
              ? 'error'
              : 'idle',
      ),
    ),
  ];
  const det = new JsHidDetector();
  const onKey = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    const editable =
      !!t &&
      (t.isContentEditable ||
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT');
    const r = det.feed({ key: ev.key, at: ev.timeStamp || performance.now() });
    if (r.kind === 'scan') {
      if (!editable) ev.preventDefault();
      hid.push(r.text, Date.now());
    } else if (!editable && ev.key === 'Enter') ev.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    for (const s of subs) void s.then((h) => h.remove());
  };
}

export type { ManualScanner };
