package com.wms3d.app.scanner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Context;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;

import androidx.test.core.app.ApplicationProvider;

import com.wms3d.scanner.HidRouter;
import com.wms3d.scanner.InputDeviceInfo;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.shadows.ShadowLooper;

import java.util.ArrayList;
import java.util.List;

/**
 * Robolectric：pre-IME 拦截（docs/04-mobile.md §2.1、§7；R3 #7）。
 * 验证：包住 content 根布局的成功/幂等/失败路径；焦点在输入框（模拟中文输入法焦点）时
 * 白名单设备的按键在 dispatchKeyEventPreIme 阶段被吞掉、不进入 EditText；非白名单设备放行。
 * 真实输入法（搜狗/百度拼音）组字行为只能真机验证（M6 发布门禁）。
 */
@RunWith(RobolectricTestRunner.class)
public class PreImeInterceptTest {
    private static final InputDeviceInfo GUN =
            new InputDeviceInfo(7, "desc-gun", "BT Scanner", 0x05e0, 0x1200, true, false);
    private static final InputDeviceInfo KEYBOARD =
            new InputDeviceInfo(9, "desc-kb", "Keyboard Case", 0x046d, 0x0001, true, false);
    private final List<String> frames = new ArrayList<>();

    @Before
    public void setUp() {
        HidRouter.resetForTest();
        HidRouter.deviceResolver = e -> e.getDeviceId() == 7 ? GUN : e.getDeviceId() == 9 ? KEYBOARD : null;
        HidRouter.INSTANCE.setListener((text, key, at) -> frames.add(text));
        ScannerInterceptLayout.setInterceptor(HidRouter::onKeyEvent);
        ScannerInterceptLayout.markInstalled(false, "reset");
    }

    @After
    public void tearDown() {
        HidRouter.resetForTest();
        ScannerInterceptLayout.setInterceptor(null);
    }

    private static KeyEvent key(int action, int code, int deviceId) {
        return new KeyEvent(0, 0, action, code, 0, 0, deviceId, 0);
    }

    /** 模拟 ViewRootImpl：先 pre-IME，未消费再交给（IME 之后的）普通分发 */
    private static void deliver(ViewGroup root, KeyEvent e) {
        if (!root.dispatchKeyEventPreIme(e)) root.dispatchKeyEvent(e);
    }

    private static void type(ViewGroup root, String s, int deviceId) {
        for (char c : s.toCharArray()) {
            int code = c == '\r' ? KeyEvent.KEYCODE_ENTER : KeyEvent.keyCodeFromString("KEYCODE_" + Character.toUpperCase(c));
            if (code == KeyEvent.KEYCODE_UNKNOWN && Character.isDigit(c)) code = KeyEvent.KEYCODE_0 + (c - '0');
            deliver(root, key(KeyEvent.ACTION_DOWN, code, deviceId));
            deliver(root, key(KeyEvent.ACTION_UP, code, deviceId));
        }
    }

    private Activity activityWithContent() {
        Activity a = Robolectric.buildActivity(Activity.class).setup().get();
        a.setContentView(new FrameLayout(a));
        return a;
    }

    /** 根布局里放一个输入框（代替 WebView 内获得焦点的 input），包住根布局并完成布局（按键分发要求 HAS_BOUNDS） */
    private EditText installWithFocusedInput(Activity a) {
        ViewGroup content = a.findViewById(android.R.id.content);
        EditText input = new EditText(a);
        ((ViewGroup) content.getChildAt(0)).addView(input);
        assertNull(ContentRootWrapper.wrap(a, content));
        ShadowLooper.idleMainLooper();
        assertTrue(input.requestFocus());
        ShadowLooper.idleMainLooper();
        return input;
    }

    @Test
    public void wrapsContentRootWithoutReparentingInnerViews() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        ViewGroup originalRoot = (ViewGroup) content.getChildAt(0);
        EditText input = new EditText(a);
        originalRoot.addView(input);

        assertNull(ContentRootWrapper.wrap(a, content));
        assertTrue(ScannerInterceptLayout.isInstalled());
        assertNull(ScannerInterceptLayout.installError());
        assertEquals(1, content.getChildCount());
        ViewGroup wrapper = (ViewGroup) content.getChildAt(0);
        assertTrue(wrapper instanceof ScannerInterceptLayout);
        assertSame(originalRoot, wrapper.getChildAt(0));
        assertSame("WebView（此处为 EditText）的父节点不变", originalRoot, input.getParent());
    }

    @Test
    public void wrapIsIdempotent() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        assertNull(ContentRootWrapper.wrap(a, content));
        ViewGroup first = (ViewGroup) content.getChildAt(0);
        assertNull(ContentRootWrapper.wrap(a, content));
        assertSame(first, content.getChildAt(0));
        assertTrue(ScannerInterceptLayout.isInstalled());
    }

    @Test
    public void failurePathsAreReportedNotThrown() {
        Context c = ApplicationProvider.getApplicationContext();
        assertEquals("android.R.id.content 不存在", ContentRootWrapper.wrap(c, null));
        assertFalse(ScannerInterceptLayout.isInstalled());
        assertEquals("android.R.id.content 不存在", ScannerInterceptLayout.installError());

        FrameLayout empty = new FrameLayout(c);
        assertTrue(ContentRootWrapper.wrap(c, empty).contains("子节点数为 0"));
        FrameLayout two = new FrameLayout(c);
        two.addView(new FrameLayout(c));
        two.addView(new FrameLayout(c));
        assertTrue(ContentRootWrapper.wrap(c, two).contains("子节点数为 2"));
        assertFalse(ScannerInterceptLayout.isInstalled());
    }

    @Test
    public void whitelistedScannerKeysSwallowedBeforeImeEvenWithInputFocused() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        EditText input = installWithFocusedInput(a);
        assertTrue(input.isFocused());
        HidRouter.INSTANCE.getPolicy().add(GUN);

        type(content, "a01\r", 7);

        assertEquals(List.of("a01"), frames);
        assertEquals("输入框（中文输入法焦点）不得收到扫码字符", "", input.getText().toString());
    }

    @Test
    public void nonWhitelistedDeviceKeysPassThroughToInput() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        EditText input = installWithFocusedInput(a);
        HidRouter.INSTANCE.getPolicy().add(GUN);

        type(content, "ab", 9);
        deliver(content, key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP, 7));

        assertEquals(List.of(), frames);
        assertEquals("ab", input.getText().toString());
    }

    @Test
    public void idleFlushEmitsFrameWithoutTerminator() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        installWithFocusedInput(a);
        HidRouter.INSTANCE.getPolicy().add(GUN);
        long[] now = {1000};
        HidRouter.clock = () -> now[0];
        type(content, "abc", 7);
        assertEquals(List.of(), frames);
        now[0] += 200;
        HidRouter.flushIdle(now[0]);
        assertEquals(List.of("abc"), frames);
    }

    @Test
    public void actionMultipleCharactersFromScanner() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        installWithFocusedInput(a);
        HidRouter.INSTANCE.getPolicy().add(GUN);
        KeyEvent multi = new KeyEvent(0, "WH1.A01-01-A01\r", 7, 0);
        assertTrue(content.dispatchKeyEventPreIme(multi));
        assertEquals(List.of("WH1.A01-01-A01"), frames);
    }

    @Test
    public void captureNextAddsDeviceToWhitelist() {
        Activity a = activityWithContent();
        ViewGroup content = a.findViewById(android.R.id.content);
        installWithFocusedInput(a);
        HidRouter.INSTANCE.getPolicy().setCaptureNext(true);
        type(content, "x1\r", 7);
        assertEquals(List.of("x1"), frames);
        assertEquals(1, HidRouter.INSTANCE.getPolicy().list().size());
    }
}
