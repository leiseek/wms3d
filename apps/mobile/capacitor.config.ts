import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wms3d.app',
  appName: 'wms3d',
  webDir: 'dist',
  android: {
    // 04 §1：低于该版本显示升级提示（实测后调整）
    minWebViewVersion: 99,
    // R2 M-N8：华为 WebView 走独立阈值（Capacitor 默认 10，几乎不拦截）。占位值，M3 真机实测后校准。
    minHuaweiWebViewVersion: 12,
  },
  server: {
    androidScheme: 'https',
    // 版本过低时加载的独立 ES5 页面（public/，不经 Vite 转译）
    errorPath: 'webview-too-old.html',
  },
};

export default config;
