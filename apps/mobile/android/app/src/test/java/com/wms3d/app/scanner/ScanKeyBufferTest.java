package com.wms3d.app.scanner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ScanKeyBufferTest {
    private static String feed(ScanKeyBuffer b, String s, long t0) {
        String out = null;
        for (int i = 0; i < s.length(); i++) {
            String r = b.onChar(s.charAt(i), t0 + i);
            if (r != null) out = r;
        }
        return out;
    }

    @Test public void emitsFrameOnEnter() {
        ScanKeyBuffer b = new ScanKeyBuffer(256, 150);
        assertEquals("WH1.A03-17-C02", feed(b, "WH1.A03-17-C02\r", 0));
    }

    @Test public void dropsEmptyFrameFromCrLf() {
        ScanKeyBuffer b = new ScanKeyBuffer(256, 150);
        assertEquals("ABC", feed(b, "ABC\r", 0));
        assertNull(b.onChar('\n', 10));
    }

    @Test public void flushesOnIdle() {
        ScanKeyBuffer b = new ScanKeyBuffer(256, 150);
        assertNull(feed(b, "6901234567890", 0));
        assertNull(b.flushIfIdle(100));
        assertEquals("6901234567890", b.flushIfIdle(300));
    }

    /** R3：超长帧整帧丢弃直到终止符，尾部不得当作新的一帧输出 */
    @Test public void overflowDiscardsUntilTerminator() {
        ScanKeyBuffer b = new ScanKeyBuffer(4, 150);
        assertNull(feed(b, "ABCDEFGH\r", 0));
        assertTrue(b.overflowCount() == 1);
        assertFalse(b.isDiscarding());
        assertEquals("XY", feed(b, "XY\r", 20));
    }

    @Test public void overflowDiscardEndsOnIdle() {
        ScanKeyBuffer b = new ScanKeyBuffer(4, 150);
        assertNull(feed(b, "ABCDEFGH", 0));
        assertTrue(b.isDiscarding());
        assertNull(b.flushIfIdle(500));
        assertFalse(b.isDiscarding());
        assertEquals("OK", feed(b, "OK\r", 600));
    }
}
