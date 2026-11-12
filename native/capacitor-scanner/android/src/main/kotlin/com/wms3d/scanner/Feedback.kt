package com.wms3d.scanner

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * 反馈（04 §2.5）：SoundPool 预载 3 个短音 + 振动。成功音只在业务校验通过后由 JS 调用。
 * 待真机验证：音量/振动强度在不同机型上的体感。
 */
class Feedback(context: Context) {
    private val pool = SoundPool.Builder()
        .setMaxStreams(2)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        .build()
    private val ok = pool.load(context, R.raw.wms3d_ok, 1)
    private val warn = pool.load(context, R.raw.wms3d_warn, 1)
    private val error = pool.load(context, R.raw.wms3d_error, 1)
    private val vibrator: Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

    fun play(type: String) {
        val (sound, vibrateMs) = when (type) {
            "ok" -> ok to 30L
            "warn" -> warn to 120L
            else -> error to 600L // 打断式拒绝：长震
        }
        pool.play(sound, 1f, 1f, 1, 0, 1f)
        vibrator?.let {
            if (Build.VERSION.SDK_INT >= 26) it.vibrate(VibrationEffect.createOneShot(vibrateMs, VibrationEffect.DEFAULT_AMPLITUDE))
            else @Suppress("DEPRECATION") it.vibrate(vibrateMs)
        }
    }

    fun release() = pool.release()
}
