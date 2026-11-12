package com.wms3d.scanner

import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent

/**
 * MainActivity 的 pre-IME Hook 调用 [onKeyEvent]（插件 API 无法自行挂到 Activity 的 pre-IME 管线，04 §2.1）。
 * 白名单设备的按键在这里被吞掉，组帧后通过 [listener] 发给 JS（ScannerPlugin → "hidScan" 事件）。
 */
object HidRouter {
    fun interface Listener {
        fun onFrame(text: String, deviceKey: String, atMs: Long)
    }

    val policy = DevicePolicy()
    private val buffers = HashMap<Int, HidWedgeBuffer>()
    private val lastDevice = HashMap<Int, InputDeviceInfo>()
    @Volatile var listener: Listener? = null
    @Volatile var capturedListener: ((InputDeviceInfo) -> Unit)? = null
    /** 测试注入：KeyEvent → 设备信息 */
    @JvmField var deviceResolver: (KeyEvent) -> InputDeviceInfo? = ::defaultDevice
    @JvmField var clock: () -> Long = { android.os.SystemClock.uptimeMillis() }
    private var handler: Handler? = null
    var interceptedKeys = 0
        private set

    @JvmStatic
    fun onKeyEvent(event: KeyEvent): Boolean {
        val dev = deviceResolver(event)
        if (policy.maybeCapture(dev)) capturedListener?.invoke(dev!!)
        if (!policy.shouldIntercept(dev)) return false
        val buf = synchronized(buffers) { buffers.getOrPut(dev!!.id) { HidWedgeBuffer() } }
        lastDevice[dev!!.id] = dev
        val now = clock()
        val r = buf.onKey(
            event.action,
            event.keyCode,
            if (event.action == KeyEvent.ACTION_MULTIPLE && event.keyCode == KeyEvent.KEYCODE_UNKNOWN) 0
            else event.getUnicodeChar(event.metaState),
            if (event.action == KeyEvent.ACTION_MULTIPLE) event.characters else null,
            now,
        )
        if (r.consumed) interceptedKeys++
        r.frame?.let { listener?.onFrame(it, dev.key, now) }
        if (r.consumed && r.frame == null && !buf.isEmpty) scheduleIdleFlush(dev.id)
        return r.consumed
    }

    /** 空闲兜底（150ms）：由主线程 Handler 触发；测试可直接调用 */
    @JvmStatic
    fun flushIdle(nowMs: Long = clock()) {
        val entries = synchronized(buffers) { buffers.entries.toList() }
        for ((id, b) in entries) b.flushIfIdle(nowMs)?.let { f ->
            listener?.onFrame(f, lastDevice[id]?.key ?: "", nowMs)
        }
    }

    fun overflowCount(): Int = synchronized(buffers) { buffers.values.sumOf { it.overflowCount } }

    private fun scheduleIdleFlush(@Suppress("UNUSED_PARAMETER") id: Int) {
        val h = handler ?: Looper.myLooper()?.let { Handler(it) }?.also { handler = it } ?: return
        h.postDelayed({ flushIdle() }, HidWedgeBuffer.DEFAULT_IDLE_MS + 5)
    }

    @JvmStatic
    fun defaultDevice(e: KeyEvent): InputDeviceInfo? {
        val d = e.device ?: InputDevice.getDevice(e.deviceId) ?: return null
        return InputDeviceInfo(
            id = d.id,
            descriptor = d.descriptor ?: "",
            name = d.name ?: "",
            vendorId = d.vendorId,
            productId = d.productId,
            alphabetic = d.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC,
            virtual = d.isVirtual,
        )
    }

    /** 测试复位 */
    @JvmStatic
    fun resetForTest() {
        synchronized(buffers) { buffers.clear() }
        lastDevice.clear()
        policy.setKeys(emptyList())
        policy.treatVirtualAsWhitelisted = false
        policy.captureNext = false
        policy.enabled = true
        listener = null
        capturedListener = null
        deviceResolver = ::defaultDevice
        interceptedKeys = 0
    }
}
