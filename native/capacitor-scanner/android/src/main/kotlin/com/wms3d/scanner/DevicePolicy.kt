package com.wms3d.scanner

/**
 * 设备识别（04 §2.1）：只拦截 KEYBOARD_TYPE_ALPHABETIC 且在白名单中的设备；
 * 白名单在设置页“测试扫码”时自动记录 descriptor + VID/PID。非白名单设备（音量键 gpio-keys、
 * 键盘皮套、USB 键盘）全部放行。debug 包可打开“软键盘视为白名单设备”开关（虚拟设备 id = -1）做手工联调。
 */
data class InputDeviceInfo(
    val id: Int,
    val descriptor: String,
    val name: String,
    val vendorId: Int,
    val productId: Int,
    val alphabetic: Boolean,
    val virtual: Boolean,
) {
    val key: String get() = "$descriptor|${"%04x".format(vendorId)}:${"%04x".format(productId)}"
}

class DevicePolicy {
    private val whitelist = LinkedHashMap<String, InputDeviceInfo>()
    @Volatile var treatVirtualAsWhitelisted = false
    /** 设置页“测试扫码”：下一台发出可打印按键的字母键盘设备自动加入白名单 */
    @Volatile var captureNext = false
    @Volatile var enabled = true

    fun shouldIntercept(d: InputDeviceInfo?): Boolean {
        if (!enabled || d == null) return false
        if (d.virtual) return treatVirtualAsWhitelisted
        if (!d.alphabetic) return false
        return whitelist.containsKey(d.key)
    }

    /** captureNext 时记录设备并返回 true（随后这一枪即被拦截） */
    fun maybeCapture(d: InputDeviceInfo?): Boolean {
        if (!captureNext || d == null || d.virtual || !d.alphabetic) return false
        synchronized(whitelist) { whitelist[d.key] = d }
        captureNext = false
        return true
    }

    fun add(d: InputDeviceInfo) = synchronized(whitelist) { whitelist[d.key] = d }
    fun remove(key: String) = synchronized(whitelist) { whitelist.remove(key) }
    fun setKeys(keys: Collection<InputDeviceInfo>) = synchronized(whitelist) {
        whitelist.clear(); keys.forEach { whitelist[it.key] = it }
    }
    fun list(): List<InputDeviceInfo> = synchronized(whitelist) { whitelist.values.toList() }
}
