package com.wms3d.scanner

import java.nio.charset.Charset

/**
 * SPP 帧切分（04 §2.2，纯 JVM 单测）：
 * - 终止符可配：CR / LF / CRLF / ANY（CR 或 LF 任一，默认）；**空帧丢弃**（CRLF 在 ANY 模式下不产生空帧）。
 * - 跨 read() 的半帧缓冲；无终止符时 [idleMs]（80ms）空闲切帧。
 * - 缓冲上限 [maxBytes]（512B）：超出整帧丢弃直到下一个终止符，计入 overflowCount。
 * - 编码 UTF-8 / GBK 可选（按字节缓冲，切完整帧后再解码，避免多字节字符被 read() 劈开）。
 */
class SppFrameSplitter(
    val terminator: Terminator = Terminator.ANY,
    charsetName: String = "UTF-8",
    private val idleMs: Long = 80,
    private val maxBytes: Int = 512,
) {
    enum class Terminator { CR, LF, CRLF, ANY }

    private val charset: Charset = Charset.forName(charsetName)
    private val buf = java.io.ByteArrayOutputStream()
    private var lastAt = -1L
    private var discarding = false
    private var pendingCr = false
    var overflowCount = 0
        private set

    fun feed(bytes: ByteArray, len: Int = bytes.size, nowMs: Long): List<String> {
        val out = ArrayList<String>()
        lastAt = nowMs
        for (i in 0 until len) {
            val b = bytes[i]
            when (terminator) {
                Terminator.CR -> if (b == CR) { emit(out); continue }
                Terminator.LF -> if (b == LF) { emit(out); continue }
                Terminator.ANY -> if (b == CR || b == LF) { emit(out); continue }
                Terminator.CRLF -> {
                    if (pendingCr) {
                        pendingCr = false
                        if (b == LF) { emit(out); continue }
                        push(CR)
                    }
                    if (b == CR) { pendingCr = true; continue }
                }
            }
            push(b)
        }
        return out
    }

    /** 无终止符的枪：80ms 空闲切帧 */
    fun flushIfIdle(nowMs: Long): String? {
        if (lastAt < 0 || nowMs - lastAt < idleMs) return null
        if (pendingCr) { pendingCr = false; push(CR) }
        if (discarding) { discarding = false; buf.reset(); return null }
        val out = ArrayList<String>(1)
        emit(out)
        return out.firstOrNull()
    }

    private fun push(b: Byte) {
        if (discarding) return
        if (buf.size() >= maxBytes) {
            buf.reset()
            discarding = true
            overflowCount++
            return
        }
        buf.write(b.toInt())
    }

    private fun emit(out: MutableList<String>) {
        if (discarding) { discarding = false; buf.reset(); return }
        if (buf.size() == 0) return
        val s = String(buf.toByteArray(), charset).trim()
        buf.reset()
        if (s.isNotEmpty()) out.add(s)
    }

    companion object {
        private const val CR: Byte = 0x0D
        private const val LF: Byte = 0x0A
        fun parseTerminator(s: String?): Terminator = when (s?.uppercase()) {
            "CR" -> Terminator.CR
            "LF" -> Terminator.LF
            "CRLF" -> Terminator.CRLF
            else -> Terminator.ANY
        }
    }
}
