package com.treshka.sklad

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncPolicyTest {
    @Test
    fun serverRolesFailClosed() {
        assertNull(SyncPolicy.normalizeServerRole(null))
        assertNull(SyncPolicy.normalizeServerRole("  "))
        assertEquals("owner", SyncPolicy.normalizeServerRole(" owner "))
        assertEquals("storekeeper", SyncPolicy.normalizeServerRole("storekeeper"))
        assertEquals("worker", SyncPolicy.normalizeServerRole("future-super-admin"))
        assertFalse(SyncPolicy.isKnownServerRole("future-super-admin"))
    }

    @Test
    fun retryPolicySeparatesPermanentAndTransientFailures() {
        assertFalse(SyncPolicy.isRetryableHttp(400))
        assertFalse(SyncPolicy.isRetryableHttp(401))
        assertTrue(SyncPolicy.isRetryableHttp(408))
        assertTrue(SyncPolicy.isRetryableHttp(425))
        assertTrue(SyncPolicy.isRetryableHttp(429))
        assertTrue(SyncPolicy.isRetryableHttp(503))
    }

    @Test
    fun retryBackoffIsBounded() {
        assertEquals(5L, SyncPolicy.retryDelaySeconds(1))
        assertEquals(10L, SyncPolicy.retryDelaySeconds(2))
        assertEquals(300L, SyncPolicy.retryDelaySeconds(20))
    }
}
