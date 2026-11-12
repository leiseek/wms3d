package com.wms3d.scanner

/**
 * HID 键盘模式缓冲（纯逻辑，无 Android 依赖，JVM 单测；docs/04-mobile.md §2.1）。
 * - 只缓冲可打印字符、Enter、Tab；其它键放行（返回 consumed=false）。
 * - 结束条件：终止符（Enter/Tab）为主，空闲 [idleMs] 为兜底（调用方定时调用 [flushIfIdle]）。
 * - 上限 [maxLen]：超长整帧丢弃直到终止符或空闲（R3），溢出计数供诊断页显示。
 * - ACTION_MULTIPLE：部分扫描枪一次发出整串 getCharacters()（R3 #8），由 [onCharacters] 处理。
 * - 只在 ACTION_DOWN / ACTION_MULTIPLE 处理；同一键的 ACTION_UP 也要吞掉（否则 WebView 收到孤立的 keyup）。
 */
class HidWedgeBuffer(
    private val maxLen: Int = DEFAULT_MAX_LEN,
    private val idleMs: Long = DEFAULT_IDLE_MS,
) {
    data class Result(val consumed: Boolean, val frame: String? = null)

    private val sb = StringBuilder()
    private var lastAt = -1L
    private var discarding = false
    var overflowCount = 0
        private set
    var framesEmitted = 0
        private set

    val isEmpty: Boolean get() = sb.isEmpty() && !discarding

    /**
     * @param action KeyEvent.ACTION_DOWN(0)/ACTION_UP(1)/ACTION_MULTIPLE(2)
     * @param keyCode KeyEvent.getKeyCode()
     * @param unicodeChar event.getUnicodeChar(event.getMetaState())（0 = 不可打印）
     * @param characters ACTION_MULTIPLE 且 KEYCODE_UNKNOWN 时的 getCharacters()
     */
    fun onKey(action: Int, keyCode: Int, unicodeChar: Int, characters: String?, nowMs: Long): Result {
        if (action == ACTION_MULTIPLE && keyCode == KEYCODE_UNKNOWN && characters != null) {
            return onCharacters(characters, nowMs)
        }
        val isTerminator = keyCode == KEYCODE_ENTER || keyCode == KEYCODE_NUMPAD_ENTER || keyCode == KEYCODE_TAB
        val printable = unicodeChar in 0x20..0x10FFFF && !Character.isISOControl(unicodeChar)
        if (!isTerminator && !printable) return Result(false)
        if (action == ACTION_UP) return Result(true)
        if (action == ACTION_MULTIPLE) {
            // 重复键（repeatCount 次）：按单字符处理一次即可，扫描枪不会产生重复
            return if (isTerminator) Result(true, terminate(nowMs)) else Result(true, append(unicodeChar.toChar(), nowMs))
        }
        if (isTerminator) return Result(true, terminate(nowMs))
        return Result(true, append(unicodeChar.toChar(), nowMs))
    }

    /** ACTION_MULTIPLE + getCharacters()：整串，可能内含 \r / \n / \t */
    fun onCharacters(chars: String, nowMs: Long): Result {
        var frame: String? = null
        for (c in chars) {
            val f = if (c == '\r' || c == '\n' || c == '\t') terminate(nowMs) else if (c.code >= 0x20) append(c, nowMs) else null
            if (f != null) frame = f
        }
        return Result(true, frame)
    }

    /** 空闲兜底：距最后一个字符 ≥ idleMs 输出已缓冲内容 */
    fun flushIfIdle(nowMs: Long): String? {
        if (lastAt < 0 || nowMs - lastAt < idleMs) return null
        if (discarding) {
            discarding = false
            sb.setLength(0)
            return null
        }
        return take()
    }

    private fun append(c: Char, nowMs: Long): String? {
        lastAt = nowMs
        if (discarding) return null
        if (sb.length >= maxLen) {
            sb.setLength(0)
            discarding = true
            overflowCount++
            return null
        }
        sb.append(c)
        return null
    }

    private fun terminate(nowMs: Long): String? {
        lastAt = nowMs
        if (discarding) {
            discarding = false
            return null
        }
        return take()
    }

    private fun take(): String? {
        if (sb.isEmpty()) return null
        val s = sb.toString()
        sb.setLength(0)
        framesEmitted++
        return s
    }

    companion object {
        const val DEFAULT_MAX_LEN = 256
        const val DEFAULT_IDLE_MS = 150L
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val ACTION_MULTIPLE = 2
        const val KEYCODE_UNKNOWN = 0
        const val KEYCODE_TAB = 61
        const val KEYCODE_ENTER = 66
        const val KEYCODE_NUMPAD_ENTER = 160
    }
}
