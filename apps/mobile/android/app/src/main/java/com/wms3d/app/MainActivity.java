package com.wms3d.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import com.wms3d.app.scanner.ContentRootWrapper;
import com.wms3d.app.scanner.ScannerInterceptLayout;
import com.wms3d.scanner.HidRouter;
import com.wms3d.scanner.ScannerPlugin;

/**
 * HID pre-IME Hook（docs/04-mobile.md §2.1）：
 * 1. {@link ContentRootWrapper} 在 android.R.id.content 下用 {@link ScannerInterceptLayout} 包住根布局，
 *    其 dispatchKeyEventPreIme 先于输入法收到物理按键 → 交给 {@link HidRouter}（白名单设备才吞键、组帧）。
 * 2. {@link #dispatchKeyEvent} 为第二道防线（拦截层安装失败或焦点不在 WebView 内时）。
 * 本地插件 {@link ScannerPlugin} 需在 super.onCreate 前注册（不经 npm，capacitor.plugins.json 不含它）。
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScannerPlugin.class);
        super.onCreate(savedInstanceState);
        ScannerInterceptLayout.setInterceptor(HidRouter::onKeyEvent);
        ContentRootWrapper.wrap(this, findViewById(android.R.id.content));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // 未经过 pre-IME（无焦点 View 或拦截层未安装）的按键：同一策略再判一次（已被 pre-IME 吞掉的不会到这里）
        if (HidRouter.onKeyEvent(event)) return true;
        return super.dispatchKeyEvent(event);
    }
}
