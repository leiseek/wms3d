package com.wms3d.scanner

import com.wms3d.scanner.SppFrameSplitter.Terminator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SppFrameSplitterTest {
    private fun b(s: String) = s.toByteArray(Charsets.UTF_8)

    @Test fun anyTerminatorCrLfNoEmptyFrames() {
        val s = SppFrameSplitter()
        assertEquals(listOf("A1", "B2", "C3"), s.feed(b("A1\r\nB2\rC3\n\n\r\n"), nowMs = 0))
    }

    @Test fun halfFrameAcrossReads() {
        val s = SppFrameSplitter()
        assertEquals(emptyList<String>(), s.feed(b("WH1.A0"), nowMs = 0))
        assertEquals(emptyList<String>(), s.feed(b("1-01-"), nowMs = 5))
        assertEquals(listOf("WH1.A01-01-A01"), s.feed(b("A01\r"), nowMs = 9))
    }

    @Test fun crlfModeKeepsLoneCr() {
        val s = SppFrameSplitter(Terminator.CRLF)
        assertEquals(listOf("A\rB"), s.feed(b("A\rB\r\n"), nowMs = 0))
        // CR 与 LF 被 read() 劈开
        assertEquals(emptyList<String>(), s.feed(b("XY\r"), nowMs = 1))
        assertEquals(listOf("XY"), s.feed(b("\n"), nowMs = 2))
    }

    @Test fun crOnlyModeTreatsLfAsData() {
        val s = SppFrameSplitter(Terminator.CR)
        assertEquals(listOf("A"), s.feed(b("A\r"), nowMs = 0))
        assertEquals(listOf("B"), s.feed(b("\nB\r"), nowMs = 1)) // trim() 去掉前导 LF
    }

    @Test fun lfOnlyMode() {
        val s = SppFrameSplitter(Terminator.LF)
        assertEquals(listOf("A", "B"), s.feed(b("A\nB\n"), nowMs = 0))
    }

    @Test fun idleFlush80msWhenNoTerminator() {
        val s = SppFrameSplitter()
        s.feed(b("6900010000004"), nowMs = 100)
        assertNull(s.flushIfIdle(150))
        assertEquals("6900010000004", s.flushIfIdle(180))
        assertNull(s.flushIfIdle(400))
    }

    @Test fun overflowDiscardsFrame() {
        val s = SppFrameSplitter(maxBytes = 8)
        assertEquals(emptyList<String>(), s.feed(b("0123456789ABCDEF\r"), nowMs = 0))
        assertEquals(1, s.overflowCount)
        assertEquals(listOf("OK"), s.feed(b("OK\r"), nowMs = 1))
    }

    @Test fun gbkDecodingAfterFrameAssembly() {
        val s = SppFrameSplitter(charsetName = "GBK")
        val gbk = "仓位A1".toByteArray(charset("GBK"))
        // 把一个双字节汉字劈在两次 read() 之间
        assertEquals(emptyList<String>(), s.feed(gbk.copyOfRange(0, 1), nowMs = 0))
        assertEquals(listOf("仓位A1"), s.feed(gbk.copyOfRange(1, gbk.size) + byteArrayOf(0x0D), nowMs = 1))
    }

    @Test fun utf8MultibyteSplit() {
        val s = SppFrameSplitter()
        val u = "货架".toByteArray(Charsets.UTF_8)
        s.feed(u.copyOfRange(0, 2), nowMs = 0)
        assertEquals(listOf("货架"), s.feed(u.copyOfRange(2, u.size) + byteArrayOf(0x0A), nowMs = 1))
    }

    @Test fun partialLengthRespected() {
        val s = SppFrameSplitter()
        val buf = ByteArray(16)
        val src = b("AB\rGARBAGE")
        System.arraycopy(src, 0, buf, 0, src.size)
        assertEquals(listOf("AB"), s.feed(buf, 3, nowMs = 0))
    }

    @Test fun parseTerminator() {
        assertEquals(Terminator.CR, SppFrameSplitter.parseTerminator("cr"))
        assertEquals(Terminator.CRLF, SppFrameSplitter.parseTerminator("CRLF"))
        assertEquals(Terminator.ANY, SppFrameSplitter.parseTerminator(null))
    }

    @Test fun backoffCapsAt3s() {
        val bo = Backoff()
        assertEquals(listOf(500L, 1000L, 2000L, 3000L, 3000L), List(5) { bo.nextDelay() })
        bo.reset()
        assertEquals(500L, bo.nextDelay())
    }
}
