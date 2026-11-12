package com.wms3d.app.scanner;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;

/**
 * 在 android.R.id.content 下插入 {@link ScannerInterceptLayout}，包住 Activity 的根布局（docs/04-mobile.md §2.1）。
 * v2.1（R2 M-N16）：不改变 WebView 的父节点。R3：任何失败只记录并通过
 * {@link ScannerInterceptLayout#isInstalled()}/{@link ScannerInterceptLayout#installError()} 暴露，不抛出。
 * 抽成静态方法以便 Robolectric 直接测试成功/幂等/失败路径。
 */
public final class ContentRootWrapper {
    private ContentRootWrapper() {}

    /** @return null 表示成功，否则为失败原因 */
    public static String wrap(Context context, ViewGroup content) {
        try {
            if (content == null) return fail("android.R.id.content 不存在");
            if (content.getChildCount() != 1)
                return fail("content 子节点数为 " + content.getChildCount() + "（期望 1）");
            View root = content.getChildAt(0);
            if (root instanceof ScannerInterceptLayout) {
                ScannerInterceptLayout.markInstalled(true, null);
                return null;
            }
            ViewGroup.LayoutParams lp = root.getLayoutParams();
            content.removeView(root);
            ScannerInterceptLayout wrapper = new ScannerInterceptLayout(context);
            wrapper.addView(root, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            if (lp != null) content.addView(wrapper, lp);
            else content.addView(wrapper);
            ScannerInterceptLayout.markInstalled(true, null);
            return null;
        } catch (RuntimeException e) {
            return fail(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private static String fail(String reason) {
        try {
            android.util.Log.w("wms3d.scanner", "pre-IME 拦截层未安装：" + reason);
        } catch (RuntimeException ignored) {
            // JVM 单测无 Log 实现
        }
        ScannerInterceptLayout.markInstalled(false, reason);
        return reason;
    }
}
