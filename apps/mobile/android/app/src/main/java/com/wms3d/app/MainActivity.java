package com.wms3d.app;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;

import com.wms3d.app.scanner.ScannerInterceptLayout;
import com.getcapacitor.BridgeActivity;

/**
 * M0a 骨架：在 android.R.id.content 下插入 {@link ScannerInterceptLayout}，包住 Activity 的根布局，
 * 在 dispatchKeyEventPreIme 阶段（先于输入法）拿到物理按键（docs/04-mobile.md §2.1）。
 * v2.1（R2 M-N16）：不再改变 WebView 的父节点——Capacitor 的 insets 处理与 ML Kit 插件
 * （把 PreviewView 插到 WebView 父节点）依赖原有层级。
 * 当前拦截器为放行模式；白名单、缓冲与 JS 事件桥在 M3 由 native/capacitor-scanner 接入。
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        wrapContentRoot();
    }

    private void wrapContentRoot() {
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null || content.getChildCount() != 1) return;
        View root = content.getChildAt(0);
        if (root instanceof ScannerInterceptLayout) return;
        ViewGroup.LayoutParams lp = root.getLayoutParams();
        content.removeView(root);
        ScannerInterceptLayout wrapper = new ScannerInterceptLayout(this);
        wrapper.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content.addView(wrapper, lp);
    }
}
