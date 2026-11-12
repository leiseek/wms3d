package com.wms3d.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicePolicyTest {
    private val gun = InputDeviceInfo(7, "desc-gun", "BT Scanner", 0x05e0, 0x1200, alphabetic = true, virtual = false)
    private val volume = InputDeviceInfo(2, "gpio-keys", "gpio-keys", 0, 0, alphabetic = false, virtual = false)
    private val keyboardCase = InputDeviceInfo(9, "desc-kb", "Keyboard Case", 0x046d, 0x0001, alphabetic = true, virtual = false)
    private val soft = InputDeviceInfo(-1, "virtual", "Virtual", 0, 0, alphabetic = true, virtual = true)

    @Test fun onlyWhitelistedAlphabeticIntercepted() {
        val p = DevicePolicy()
        p.add(gun)
        assertTrue(p.shouldIntercept(gun))
        assertFalse(p.shouldIntercept(volume))
        assertFalse(p.shouldIntercept(keyboardCase))
        assertFalse(p.shouldIntercept(null))
    }

    @Test fun whitelistMatchesByDescriptorAndVidPidNotRuntimeId() {
        val p = DevicePolicy()
        p.add(gun)
        assertTrue(p.shouldIntercept(gun.copy(id = 42)))
        assertFalse(p.shouldIntercept(gun.copy(productId = 0x9999)))
    }

    @Test fun softKeyboardToggle() {
        val p = DevicePolicy()
        assertFalse(p.shouldIntercept(soft))
        p.treatVirtualAsWhitelisted = true
        assertTrue(p.shouldIntercept(soft))
    }

    @Test fun captureNextRecordsFirstAlphabeticDevice() {
        val p = DevicePolicy()
        p.captureNext = true
        assertFalse(p.maybeCapture(volume))
        assertFalse(p.maybeCapture(soft))
        assertTrue(p.maybeCapture(gun))
        assertFalse(p.captureNext)
        assertEquals(listOf(gun), p.list())
        assertTrue(p.shouldIntercept(gun))
    }

    @Test fun disabledInterceptsNothing() {
        val p = DevicePolicy()
        p.add(gun)
        p.enabled = false
        assertFalse(p.shouldIntercept(gun))
    }
}
