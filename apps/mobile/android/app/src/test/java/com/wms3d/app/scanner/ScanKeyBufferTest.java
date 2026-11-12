package com.wms3d.app.scanner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

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

    @Test public void overflowResets() {
        ScanKeyBuffer b = new ScanKeyBuffer(4, 150);
        assertNull(feed(b, "ABCDE", 0));
        assertEquals("F", feed(b, "F\r", 10));
    }
}
