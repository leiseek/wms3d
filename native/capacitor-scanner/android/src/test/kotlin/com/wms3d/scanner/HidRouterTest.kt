package com.wms3d.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** HidRouter 路由逻辑（不依赖 KeyEvent 实例的部分）；pre-IME 端到端见 App 的 Robolectric 测试。 */
class HidRouterTest {
    @Test fun policySharedSingleton() {
        HidRouter.resetForTest()
        assertTrue(HidRouter.policy.enabled)
        assertFalse(HidRouter.policy.treatVirtualAsWhitelisted)
        assertEquals(0, HidRouter.overflowCount())
    }
}
