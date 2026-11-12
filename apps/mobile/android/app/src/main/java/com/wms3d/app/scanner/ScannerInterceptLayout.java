package com.wms3d.app.scanner;

import android.content.Context;
import android.view.KeyEvent;
import android.widget.FrameLayout;

/**
 * pre-IME 按键拦截点。dispatchKeyEventPreIme 沿焦点链自父 View 下发，先于 IME，
 * 因此焦点在中文输入法输入框时也能拿到扫码枪的原始按键。
 * M0a：拦截器默认放行（返回 false）；M3 设置白名单设备的拦截器。
 */
public class ScannerInterceptLayout extends FrameLayout {
    public interface Interceptor {
        /** @return true 表示已消费（吞键），不再交给 WebView/IME */
        boolean onPreImeKey(KeyEvent event);
    }

    private static volatile Interceptor interceptor = event -> false;
    /** 是否已成功插入根布局（诊断页读取；R3：失败时 HID 拦截不可用，需要提示改用 SPP 或无焦点模式） */
    private static volatile boolean installed = false;
    private static volatile String installError = null;

    public static boolean isInstalled() {
        return installed;
    }

    /** 未安装时的原因（诊断页显示），已安装为 null */
    public static String installError() {
        return installError;
    }

    public static void markInstalled(boolean ok, String error) {
        installed = ok;
        installError = ok ? null : error;
    }

    public static void setInterceptor(Interceptor value) {
        interceptor = value != null ? value : event -> false;
    }

    public ScannerInterceptLayout(Context context) {
        super(context);
    }

    @Override
    public boolean dispatchKeyEventPreIme(KeyEvent event) {
        if (interceptor.onPreImeKey(event)) return true;
        return super.dispatchKeyEventPreIme(event);
    }
}
