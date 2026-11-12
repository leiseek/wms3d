package com.wms3d.app;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.wms3d.app.scanner.ScannerInterceptLayout;

/**
 * M0a 骨架：用 {@link ScannerInterceptLayout} 包住 Capacitor WebView，
 * 在 dispatchKeyEventPreIme 阶段（先于输入法）拿到物理按键（docs/04-mobile.md §2.1）。
 * 当前拦截器为放行模式；设备白名单、缓冲与 JS 事件桥在 M3 由 native/capacitor-scanner 接入。
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wrapWebView();
    }

    private void wrapWebView() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null || !(webView.getParent() instanceof ViewGroup)) return;
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent instanceof ScannerInterceptLayout) return;
        int index = parent.indexOfChild(webView);
        ViewGroup.LayoutParams lp = webView.getLayoutParams();
        parent.removeView(webView);
        ScannerInterceptLayout wrapper = new ScannerInterceptLayout(this);
        wrapper.addView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent.addView(wrapper, index, lp);
    }
}
