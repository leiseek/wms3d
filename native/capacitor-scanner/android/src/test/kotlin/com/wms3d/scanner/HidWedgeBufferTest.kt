package com.wms3d.scanner

import com.wms3d.scanner.HidWedgeBuffer.Companion.ACTION_DOWN
import com.wms3d.scanner.HidWedgeBuffer.Companion.ACTION_MULTIPLE
import com.wms3d.scanner.HidWedgeBuffer.Companion.ACTION_UP
import com.wms3d.scanner.HidWedgeBuffer.Companion.KEYCODE_ENTER
import com.wms3d.scanner.HidWedgeBuffer.Companion.KEYCODE_TAB
import com.wms3d.scanner.HidWedgeBuffer.Companion.KEYCODE_UNKNOWN
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HidWedgeBufferTest {
    private val KEY_A = 29

    private fun type(b: HidWedgeBuffer, s: String, t0: Long = 0): String? {
        var frame: String? = null
        s.forEachIndexed { i, c ->
            val code = if (c == '\r') KEYCODE_ENTER else if (c == '\t') KEYCODE_TAB else KEY_A
            val uc = if (c == '\r' || c == '\t') 0 else c.code
            val down = b.onKey(ACTION_DOWN, code, uc, null, t0 + i)
            assertTrue("DOWN 必须被吞", down.consumed)
            if (down.frame != null) frame = down.frame
            assertTrue("UP 必须被吞", b.onKey(ACTION_UP, code, uc, null, t0 + i).consumed)
        }
        return frame
    }

    @Test fun framesOnEnter() {
        val b = HidWedgeBuffer()
        assertEquals("WH1.A03-17-C02", type(b, "WH1.A03-17-C02\r"))
        assertEquals(1, b.framesEmitted)
    }

    @Test fun tabTerminates() {
        assertEquals("6900010000004", type(HidWedgeBuffer(), "6900010000004\t"))
    }

    @Test fun shiftedCharsArriveViaUnicodeChar() {
        // getUnicodeChar(metaState) 已处理 Shift：缓冲器只看 unicodeChar
        val b = HidWedgeBuffer()
        b.onKey(ACTION_DOWN, KEY_A, 'A'.code, null, 0)
        b.onKey(ACTION_DOWN, 69 /*MINUS*/, '_'.code, null, 1)
        assertEquals("A_", b.onKey(ACTION_DOWN, KEYCODE_ENTER, 0, null, 2).frame)
    }

    @Test fun nonPrintableKeysPassThrough() {
        val b = HidWedgeBuffer()
        val vol = b.onKey(ACTION_DOWN, 24 /*VOLUME_UP*/, 0, null, 0)
        assertFalse(vol.consumed)
        val shift = b.onKey(ACTION_DOWN, 59 /*SHIFT_LEFT*/, 0, null, 0)
        assertFalse(shift.consumed)
        assertTrue(b.isEmpty)
    }

    @Test fun idleFlushAfter150ms() {
        val b = HidWedgeBuffer()
        assertNull(type(b, "ABC123", 0))
        assertNull(b.flushIfIdle(100))
        assertEquals("ABC123", b.flushIfIdle(160))
        assertNull(b.flushIfIdle(400))
    }

    @Test fun overflowDiscardsWholeFrameUntilTerminator() {
        val b = HidWedgeBuffer(maxLen = 4)
        assertNull(type(b, "ABCDEFGH\r"))
        assertEquals(1, b.overflowCount)
        assertEquals("XY", type(b, "XY\r", 100))
    }

    @Test fun overflowDiscardEndsOnIdle() {
        val b = HidWedgeBuffer(maxLen = 4)
        type(b, "ABCDEFG")
        assertFalse(b.isEmpty)
        assertNull(b.flushIfIdle(1000))
        assertTrue(b.isEmpty)
    }

    @Test fun actionMultipleCharacters() {
        // 部分扫描枪：一次 ACTION_MULTIPLE + KEYCODE_UNKNOWN + getCharacters()（R3 #8）
        val b = HidWedgeBuffer()
        val r = b.onKey(ACTION_MULTIPLE, KEYCODE_UNKNOWN, 0, "WH1.A01-01-A01\r", 0)
        assertTrue(r.consumed)
        assertEquals("WH1.A01-01-A01", r.frame)
    }

    @Test fun actionMultipleWithoutTerminatorThenEnter() {
        val b = HidWedgeBuffer()
        assertNull(b.onKey(ACTION_MULTIPLE, KEYCODE_UNKNOWN, 0, "中文条码", 0).frame)
        assertEquals("中文条码", b.onKey(ACTION_DOWN, KEYCODE_ENTER, 0, null, 5).frame)
    }

    @Test fun actionMultipleCrLfProducesSingleFrame() {
        val b = HidWedgeBuffer()
        assertEquals("ABC", b.onCharacters("ABC\r\n", 0).frame)
        assertEquals(1, b.framesEmitted)
    }

    @Test fun emptyTerminatorIgnored() {
        val b = HidWedgeBuffer()
        val r = b.onKey(ACTION_DOWN, KEYCODE_ENTER, 0, null, 0)
        assertTrue(r.consumed)
        assertNull(r.frame)
    }
}
