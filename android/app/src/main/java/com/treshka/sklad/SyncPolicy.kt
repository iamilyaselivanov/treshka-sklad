package com.treshka.sklad

internal enum class LegacyOutboxMigration {
    NONE,
    ZERO_BASE_ROWS,
    ALL_PENDING_ROWS,
}

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

    /**
     * Schema v7 incorrectly replaced every zero base revision with the current
     * server revision. When upgrading from that exact schema the original
     * provenance is unknowable, so every queued snapshot must be quarantined.
     * Older schemas can safely quarantine only ambiguous zero-base rows.
     */
    fun legacyOutboxMigration(oldVersion: Int, serverRevision: Long): LegacyOutboxMigration =
        when {
            serverRevision <= 0L -> LegacyOutboxMigration.NONE
            oldVersion == 7 -> LegacyOutboxMigration.ALL_PENDING_ROWS
            oldVersion < 7 -> LegacyOutboxMigration.ZERO_BASE_ROWS
            else -> LegacyOutboxMigration.NONE
        }

    /**
     * Only a fresh, never-attempted snapshot created behind the acknowledged
     * in-flight snapshot inherits its new revision. A manually requeued
     * historical snapshot has attempts > 0 and must earn its own CAS result.
     */
    fun shouldAdvanceQueuedSnapshot(
        attempts: Int,
        conflict: Boolean,
        baseRevision: Long,
        appliedBaseRevision: Long,
    ): Boolean = attempts == 0 && !conflict && baseRevision == appliedBaseRevision
}
