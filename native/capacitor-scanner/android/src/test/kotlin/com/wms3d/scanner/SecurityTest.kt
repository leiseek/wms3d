package com.wms3d.scanner

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SecurityTest {
    @Test fun spkiPinFormat() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val pin = SpkiPin.of(kp.public)
        val want = "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(kp.public.encoded))
        assertEquals(want, pin)
        assertTrue(pin.length == 7 + 44)
    }

    @Test fun pinMatchingSupportsRotationList() {
        val a = "sha256/AAAA"
        val b = "sha256/BBBB"
        assertTrue(SpkiPin.matches(listOf("sha256/leaf", b), "$a, $b"))
        assertFalse(SpkiPin.matches(listOf("sha256/leaf"), "$a,$b"))
        assertFalse(SpkiPin.matches(listOf(a), "md5/AAAA"))
        assertFalse(SpkiPin.matches(listOf(a), ""))
    }

    @Test fun cryptoBoxRoundTripAndTamper() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val sealed = CryptoBox.seal(key, "mockr.refresh-token", "wms3d.refreshToken")
        assertTrue(sealed.startsWith("v1:"))
        assertEquals("mockr.refresh-token", CryptoBox.open(key, sealed, "wms3d.refreshToken"))
        assertNotEquals(sealed, CryptoBox.seal(key, "mockr.refresh-token", "wms3d.refreshToken"))
        val threw = try { CryptoBox.open(key, sealed, "other-key"); false } catch (_: AEADBadTagException) { true }
        assertTrue("AAD 绑定存储键，换键解密必须失败", threw)
    }
}
