package com.wms3d.scanner

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.IOException
import java.util.UUID

/**
 * SPP 串口扫码枪连接（04 §2.2）。**待真机验证**：本机无蓝牙/设备，仅帧切分与退避有 JVM 单测。
 * 连接顺序：只连已配对 → cancelDiscovery()（try/catch）→ secure RFCOMM → insecure RFCOMM →
 * （allowReflectionFallback 时）反射 createRfcommSocket(1)（非 SDK 接口，记日志）。
 * 断连后前台退避 0.5s→3s 重连；ACL_CONNECTED 广播与 onResume 立即重连（由 ScannerPlugin 驱动）。
 */
@SuppressLint("MissingPermission")
class SppClient(
    private val adapter: BluetoothAdapter,
    private val listener: Listener,
) {
    interface Listener {
        fun onState(state: String, detail: String?)
        fun onFrame(text: String, address: String, atMs: Long)
    }

    data class Options(
        val address: String,
        val terminator: SppFrameSplitter.Terminator,
        val charset: String,
        val allowReflectionFallback: Boolean,
    )

    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var opts: Options? = null
    @Volatile private var wanted = false
    private var thread: Thread? = null
    private val backoff = Backoff()
    private val main = Handler(Looper.getMainLooper())
    @Volatile var state: String = "idle"
        private set

    fun connect(o: Options) {
        opts = o
        wanted = true
        backoff.reset()
        startThread()
    }

    fun reconnectNow() {
        if (wanted && state != "ready" && state != "connecting") {
            backoff.reset()
            startThread()
        }
    }

    fun disconnect() {
        wanted = false
        closeSocket()
        setState("idle", null)
    }

    private fun setState(s: String, d: String?) {
        state = s
        main.post { listener.onState(s, d) }
    }

    private fun startThread() {
        if (thread?.isAlive == true) return
        thread = Thread({ loop() }, "wms3d-spp").apply { isDaemon = true; start() }
    }

    private fun loop() {
        while (wanted) {
            val o = opts ?: return
            setState("connecting", o.address)
            try {
                val s = open(o)
                socket = s
                backoff.reset()
                setState("ready", o.address)
                read(s, o)
            } catch (e: IOException) {
                Log.w(TAG, "SPP 连接/读取失败：${e.message}")
            } catch (e: SecurityException) {
                setState("error", "缺少蓝牙权限")
                wanted = false
                return
            }
            closeSocket()
            if (!wanted) break
            setState("error", "已断开，正在重连")
            try { Thread.sleep(backoff.nextDelay()) } catch (_: InterruptedException) { return }
        }
    }

    private fun open(o: Options): BluetoothSocket {
        val dev: BluetoothDevice = adapter.bondedDevices.firstOrNull { it.address == o.address }
            ?: throw IOException("设备未配对：${o.address}")
        try { adapter.cancelDiscovery() } catch (_: SecurityException) { /* 无 SCAN 权限时忽略 */ }
        try {
            return dev.createRfcommSocketToServiceRecord(SPP_UUID).also { it.connect() }
        } catch (e: IOException) {
            Log.w(TAG, "secure RFCOMM 失败，回退 insecure：${e.message}")
        }
        try {
            return dev.createInsecureRfcommSocketToServiceRecord(SPP_UUID).also { it.connect() }
        } catch (e: IOException) {
            if (!o.allowReflectionFallback) throw e
            Log.w(TAG, "insecure RFCOMM 失败，使用反射 createRfcommSocket(1)（非 SDK 接口）")
        }
        @Suppress("DiscouragedPrivateApi")
        val m = dev.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
        return (m.invoke(dev, 1) as BluetoothSocket).also { it.connect() }
    }

    private fun read(s: BluetoothSocket, o: Options) {
        val split = SppFrameSplitter(o.terminator, o.charset)
        val input = s.inputStream
        val buf = ByteArray(256)
        while (wanted) {
            // available() 轮询以便执行 80ms 空闲切帧（read() 会阻塞）
            if (input.available() > 0) {
                val n = input.read(buf)
                if (n < 0) throw IOException("EOF")
                val now = android.os.SystemClock.uptimeMillis()
                for (f in split.feed(buf, n, now)) main.post { listener.onFrame(f, o.address, now) }
            } else {
                split.flushIfIdle(android.os.SystemClock.uptimeMillis())?.let { f ->
                    main.post { listener.onFrame(f, o.address, android.os.SystemClock.uptimeMillis()) }
                }
                Thread.sleep(10)
            }
        }
    }

    private fun closeSocket() {
        try { socket?.close() } catch (_: IOException) {}
        socket = null
    }

    companion object {
        private const val TAG = "wms3d.spp"
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
