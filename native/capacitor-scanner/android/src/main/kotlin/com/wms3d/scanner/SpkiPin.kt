package com.wms3d.scanner

import java.security.MessageDigest
import java.security.PublicKey
import java.util.Base64

/**
 * SPKI 指纹（04 §1，D35/M3b）：`sha256/<base64(SHA-256(SubjectPublicKeyInfo DER))>`，与 HPKP/OkHttp 格式一致。
 * 只在首次配置与每次启动时校验（v2.1 M-N19）；运行期 WebView 请求依赖系统 + 用户锚点。
 */
object SpkiPin {
    fun of(key: PublicKey): String = of(key.encoded)

    fun of(spkiDer: ByteArray): String =
        "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(spkiDer))

    /** 配置码可携带多个指纹（证书轮换：新旧两个），逗号分隔；链上任一证书匹配即通过 */
    fun matches(chainPins: List<String>, expected: String): Boolean {
        val want = expected.split(',').map { it.trim() }.filter { it.startsWith("sha256/") }.toSet()
        if (want.isEmpty()) return false
        return chainPins.any { it in want }
    }
}
