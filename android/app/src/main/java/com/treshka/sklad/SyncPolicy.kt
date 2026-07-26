package com.treshka.sklad

internal object SyncPolicy {
    private val serverRoles = setOf("owner", "admin", "storekeeper", "worker")

    fun normalizeServerRole(rawRole: String?): String? {
        val role = rawRole?.trim().orEmpty()
        if (role.isBlank()) return null
        return if (role in serverRoles) role else "worker"
    }

    fun isKnownServerRole(rawRole: String): Boolean = rawRole.trim() in serverRoles

    fun isRetryableHttp(status: Int): Boolean =
        status == 408 || status == 425 || status == 429 || status >= 500

    fun retryDelaySeconds(attempt: Int): Long {
        val exponent = (attempt - 1).coerceIn(0, 6)
        return (5L * (1L shl exponent)).coerceAtMost(300L)
    }
}
