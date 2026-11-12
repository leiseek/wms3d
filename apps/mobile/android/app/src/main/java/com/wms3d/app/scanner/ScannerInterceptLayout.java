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
