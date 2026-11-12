package com.wms3d.scanner

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection

/**
 * JS 桥（TS 定义见 native/capacitor-scanner/src/definitions.ts）。HID 拦截本身在 App 的 MainActivity（pre-IME），
 * 这里只转发 [HidRouter] 的帧并提供配置；SPP、反馈、证书指纹校验、软键盘、Keystore 加密存储均在本插件。
 */
@CapacitorPlugin(
    name = "Wms3dScanner",
    permissions = [
        Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN]),
    ],
)
class ScannerPlugin : Plugin() {
    private var feedback: Feedback? = null
    private var spp: SppClient? = null
    private var aclReceiver: BroadcastReceiver? = null
    private var pausedAt = 0L

    override fun load() {
        feedback = Feedback(context)
        HidRouter.listener = HidRouter.Listener { text, key, at ->
            notifyListeners("hidScan", JSObject().put("text", text).put("deviceKey", key).put("at", at))
        }
        HidRouter.capturedListener = { d -> notifyListeners("hidDeviceCaptured", deviceJson(d)) }
        loadWhitelist()
    }

    override fun handleOnDestroy() {
        feedback?.release()
        spp?.disconnect()
        aclReceiver?.let { runCatching { context.unregisterReceiver(it) } }
    }

    override fun handleOnPause() {
        pausedAt = System.currentTimeMillis()
    }

    override fun handleOnResume() {
        // 后台超过 5 分钟已断开省电 → 回前台立即重连
        spp?.reconnectNow()
    }

    // ---------- HID ----------
    @PluginMethod
    fun getHidStatus(call: PluginCall) {
        val installed = runCatching {
            val c = Class.forName("com.wms3d.app.scanner.ScannerInterceptLayout")
            (c.getMethod("isInstalled").invoke(null) as Boolean) to (c.getMethod("installError").invoke(null) as String?)
        }.getOrDefault(false to "拦截层类不存在")
        val wl = JSArray()
        HidRouter.policy.list().forEach { wl.put(deviceJson(it)) }
        call.resolve(
            JSObject()
                .put("installed", installed.first)
                .put("installError", installed.second)
                .put("overflowCount", HidRouter.overflowCount())
                .put("interceptedKeys", HidRouter.interceptedKeys)
                .put("treatSoftKeyboardAsScanner", HidRouter.policy.treatVirtualAsWhitelisted)
                .put("enabled", HidRouter.policy.enabled)
                .put("whitelist", wl),
        )
    }

    @PluginMethod
    fun setHidConfig(call: PluginCall) {
        call.getBoolean("enabled")?.let { HidRouter.policy.enabled = it }
        call.getBoolean("treatSoftKeyboardAsScanner")?.let {
            // 只在 debug 包生效（04 §7：“软键盘视为白名单设备”联调开关）
            val debuggable = (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            HidRouter.policy.treatVirtualAsWhitelisted = it && debuggable
        }
        call.getBoolean("captureNext")?.let { HidRouter.policy.captureNext = it }
        call.getString("removeDeviceKey")?.let { HidRouter.policy.remove(it); saveWhitelist() }
        call.resolve()
    }

    // ---------- SPP ----------
    @SuppressLint("MissingPermission")
    @PluginMethod
    fun listPairedDevices(call: PluginCall) {
        if (!hasBt()) return requestPermissionForAlias("bluetooth", call, "btPermsThenList")
        val out = JSArray()
        adapter()?.bondedDevices?.forEach { d: BluetoothDevice ->
            out.put(JSObject().put("name", d.name ?: d.address).put("address", d.address))
        }
        call.resolve(JSObject().put("devices", out))
    }

    @PermissionCallback
    private fun btPermsThenList(call: PluginCall) {
        if (hasBt()) listPairedDevices(call) else call.reject("蓝牙权限被拒绝，请在系统设置中允许“附近的设备”", "PERMISSION_DENIED")
    }

    @PluginMethod
    fun connectSpp(call: PluginCall) {
        if (!hasBt()) return requestPermissionForAlias("bluetooth", call, "btPermsThenConnect")
        val a = adapter() ?: return call.reject("设备不支持蓝牙", "UNAVAILABLE")
        val address = call.getString("address") ?: return call.reject("缺少 address")
        val client = spp ?: SppClient(a, object : SppClient.Listener {
            override fun onState(state: String, detail: String?) {
                notifyListeners("sppState", JSObject().put("state", state).put("detail", detail))
            }
            override fun onFrame(text: String, address: String, atMs: Long) {
                notifyListeners("sppScan", JSObject().put("text", text).put("deviceKey", address).put("at", atMs))
            }
        }).also { spp = it }
        client.connect(
            SppClient.Options(
                address = address,
                terminator = SppFrameSplitter.parseTerminator(call.getString("terminator")),
                charset = call.getString("charset") ?: "UTF-8",
                allowReflectionFallback = call.getBoolean("allowReflectionFallback") ?: false,
            ),
        )
        registerAcl(address)
        call.resolve()
    }

    @PermissionCallback
    private fun btPermsThenConnect(call: PluginCall) {
        if (hasBt()) connectSpp(call) else call.reject("蓝牙权限被拒绝", "PERMISSION_DENIED")
    }

    @PluginMethod
    fun disconnectSpp(call: PluginCall) {
        spp?.disconnect()
        call.resolve()
    }

    @PluginMethod
    fun sppStatus(call: PluginCall) {
        call.resolve(JSObject().put("state", spp?.state ?: "idle"))
    }

    // ---------- 反馈 ----------
    @PluginMethod
    fun feedback(call: PluginCall) {
        feedback?.play(call.getString("type") ?: "ok")
        call.resolve()
    }

    // ---------- 证书指纹（启动 / 配置时） ----------
    @PluginMethod
    fun verifyServerPin(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("缺少 url")
        val pin = call.getString("pin") ?: return call.reject("缺少 pin")
        Thread {
            try {
                val conn = URL(url).openConnection() as? HttpsURLConnection
                    ?: return@Thread call.resolve(JSObject().put("ok", false).put("reason", "不是 https 地址"))
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.connect()
                val pins = conn.serverCertificates.filterIsInstance<X509Certificate>().map { SpkiPin.of(it.publicKey) }
                conn.disconnect()
                val ok = SpkiPin.matches(pins, pin)
                val r = JSObject().put("ok", ok).put("serverPins", JSArray(pins))
                if (!ok) r.put("reason", "证书指纹不符")
                call.resolve(r)
            } catch (e: Exception) {
                call.resolve(JSObject().put("ok", false).put("reason", e.message ?: e.javaClass.simpleName))
            }
        }.start()
    }

    // ---------- 软键盘 ----------
    @PluginMethod
    fun showSoftInput(call: PluginCall) {
        activity.runOnUiThread {
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val v = bridge.webView
            v.requestFocus()
            val shown = imm.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT)
            call.resolve(JSObject().put("shown", shown))
        }
    }

    @PluginMethod
    fun openHardKeyboardSettings(call: PluginCall) {
        val i = Intent(if (Build.VERSION.SDK_INT >= 24) Settings.ACTION_HARD_KEYBOARD_SETTINGS else Settings.ACTION_INPUT_METHOD_SETTINGS)
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(i) }.onFailure { context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        call.resolve()
    }

    // ---------- Keystore 加密存储 ----------
    @PluginMethod
    fun secureSet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("缺少 key")
        val value = call.getString("value") ?: return call.reject("缺少 value")
        val sealed = CryptoBox.seal(KeystoreKeys.key(), value, key)
        prefs().edit().putString(key, sealed).apply()
        call.resolve()
    }

    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("缺少 key")
        val sealed = prefs().getString(key, null)
        val value = sealed?.let { runCatching { CryptoBox.open(KeystoreKeys.key(), it, key) }.getOrNull() }
        call.resolve(JSObject().put("value", value))
    }

    @PluginMethod
    fun secureRemove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("缺少 key")
        prefs().edit().remove(key).apply()
        call.resolve()
    }

    // ---------- 内部 ----------
    private fun prefs() = context.getSharedPreferences("wms3d.secure", Context.MODE_PRIVATE)

    private fun adapter(): BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun hasBt(): Boolean =
        Build.VERSION.SDK_INT < 31 || getPermissionState("bluetooth") == PermissionState.GRANTED

    private fun registerAcl(address: String) {
        if (aclReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                @Suppress("DEPRECATION")
                val d: BluetoothDevice? = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                if (d?.address != address) return
                if (i.action == BluetoothDevice.ACTION_ACL_CONNECTED) spp?.reconnectNow()
                if (i.action == BluetoothDevice.ACTION_ACL_DISCONNECTED)
                    notifyListeners("sppState", JSObject().put("state", "error").put("detail", "扫码枪已断开"))
            }
        }
        val f = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
        }
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, f, Context.RECEIVER_EXPORTED)
        else context.registerReceiver(r, f)
        aclReceiver = r
    }

    private fun deviceJson(d: InputDeviceInfo) = JSObject()
        .put("key", d.key).put("name", d.name).put("vendorId", d.vendorId).put("productId", d.productId)

    private fun loadWhitelist() {
        val p = context.getSharedPreferences("wms3d.hid", Context.MODE_PRIVATE)
        val set = p.getStringSet("whitelist", emptySet()) ?: emptySet()
        HidRouter.policy.setKeys(set.mapNotNull { decode(it) })
        HidRouter.capturedListener = { d ->
            saveWhitelist()
            notifyListeners("hidDeviceCaptured", deviceJson(d))
        }
    }

    private fun saveWhitelist() {
        val p = context.getSharedPreferences("wms3d.hid", Context.MODE_PRIVATE)
        p.edit().putStringSet("whitelist", HidRouter.policy.list().map { encode(it) }.toSet()).apply()
    }

    private fun encode(d: InputDeviceInfo) = listOf(d.descriptor, d.name.replace('\t', ' '), d.vendorId, d.productId).joinToString("\t")
    private fun decode(s: String): InputDeviceInfo? {
        val p = s.split('\t')
        if (p.size != 4) return null
        return InputDeviceInfo(-1, p[0], p[1], p[2].toIntOrNull() ?: 0, p[3].toIntOrNull() ?: 0, alphabetic = true, virtual = false)
    }
}
