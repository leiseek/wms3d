package com.wms3d.scanner

/** SPP 重连退避（04 §2.2）：前台 0.5s 起倍增，上限 3s；成功后复位。 */
class Backoff(private val initialMs: Long = 500, private val maxMs: Long = 3000) {
    private var next = initialMs
    fun nextDelay(): Long {
        val d = next
        next = minOf(maxMs, next * 2)
        return d
    }
    fun reset() { next = initialMs }
}
