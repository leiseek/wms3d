import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wms3d.app',
  appName: 'wms3d',
  webDir: 'dist',
  android: {
    // 04 §1：低于该版本显示升级提示（实测后调整）
    minWebViewVersion: 99,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
