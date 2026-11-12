package com.wms3d.scanner

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-GCM 信封（refreshToken 加密存储，04 §4）：`v1:<base64(iv)>:<base64(ciphertext+tag)>`。
 * 密钥由 [KeystoreKeys] 从 AndroidKeyStore 取得（不可导出）；JVM 单测用软件密钥验证同一套信封格式。
 */
object CryptoBox {
    private const val TAG_BITS = 128
    private const val IV_LEN = 12

    fun seal(key: SecretKey, plain: String, aad: String? = null): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        // AndroidKeyStore 要求由 Cipher 生成 IV（randomizedEncryptionRequired），软件密钥同样适用
        c.init(Cipher.ENCRYPT_MODE, key)
        aad?.let { c.updateAAD(it.toByteArray()) }
        val ct = c.doFinal(plain.toByteArray(Charsets.UTF_8))
        val iv = c.iv
        require(iv.size == IV_LEN) { "unexpected IV length ${iv.size}" }
        val enc = Base64.getEncoder()
        return "v1:${enc.encodeToString(iv)}:${enc.encodeToString(ct)}"
    }

    fun open(key: SecretKey, sealed: String, aad: String? = null): String {
        val parts = sealed.split(':')
        require(parts.size == 3 && parts[0] == "v1") { "bad envelope" }
        val dec = Base64.getDecoder()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, dec.decode(parts[1])))
        aad?.let { c.updateAAD(it.toByteArray()) }
        return String(c.doFinal(dec.decode(parts[2])), Charsets.UTF_8)
    }

    /** 测试用 */
    fun randomIv(): ByteArray = ByteArray(IV_LEN).also { SecureRandom().nextBytes(it) }
}
