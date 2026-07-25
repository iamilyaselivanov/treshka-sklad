package com.treshka.sklad

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class SyncConfig(
    val baseUrl: String,
    val authToken: String,
    val deviceId: String,
    val serverRevision: Long,
)

data class PendingSnapshot(
    val mutationId: String,
    val payload: String,
    val schemaVersion: Int,
    val attempts: Int,
)

/**
 * Надёжное offline-first хранилище.
 *
 * v1 содержала только основной и резервный снимки. v2 ДОБАВЛЯЕТ очередь
 * синхронизации и конфигурацию сервера через CREATE TABLE IF NOT EXISTS. Ни одна
 * миграция не удаляет и не переименовывает старые таблицы, поэтому обновление APK
 * не может уничтожить накопленные данные.
 */
class AppStateStore(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val TAG = "AppStateStore"
        private const val DB_NAME = "sklad_state.db"
        private const val DB_VERSION = 4
        private const val STATE_TABLE = "app_state"
        private const val ROW_ID = 1L
    }

    private val tokenVault = SyncTokenVault(context.applicationContext)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $STATE_TABLE (
                id INTEGER PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                backup_schema_version INTEGER,
                backup_payload TEXT,
                backup_updated_at INTEGER
            )
            """.trimIndent()
        )
        createSyncTables(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createSyncTables(db)
        if (oldVersion == 2 && newVersion >= 3) {
            db.execSQL(
                "ALTER TABLE sync_outbox ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0",
            )
        }
        if (oldVersion < 4) createPendingRemoteTable(db)
    }

    private fun createSyncTables(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sync_outbox (
                mutation_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                conflict INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sync_config (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                base_url TEXT NOT NULL DEFAULT '',
                auth_token TEXT NOT NULL DEFAULT '',
                device_id TEXT NOT NULL,
                server_revision INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER,
                last_error TEXT
            )
            """.trimIndent()
        )
        val values = ContentValues().apply {
            put("id", ROW_ID)
            put("device_id", UUID.randomUUID().toString())
        }
        db.insertWithOnConflict("sync_config", null, values, SQLiteDatabase.CONFLICT_IGNORE)
        createPendingRemoteTable(db)
    }

    private fun createPendingRemoteTable(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS sync_remote_pending (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                payload TEXT NOT NULL,
                revision INTEGER NOT NULL,
                received_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    private fun writeState(db: SQLiteDatabase, payload: String, schemaVersion: Int): Boolean {
        val values = ContentValues()
        db.query(
            STATE_TABLE,
            arrayOf("schema_version", "payload", "updated_at"),
            "id = ?",
            arrayOf(ROW_ID.toString()),
            null,
            null,
            null,
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                values.put("backup_schema_version", cursor.getInt(0))
                values.put("backup_payload", cursor.getString(1))
                values.put("backup_updated_at", cursor.getLong(2))
            }
        }
        values.put("id", ROW_ID)
        values.put("schema_version", schemaVersion)
        values.put("payload", payload)
        values.put("updated_at", System.currentTimeMillis())
        return db.insertWithOnConflict(
            STATE_TABLE,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
        ) != -1L
    }

    /**
     * Локальная запись и постановка полного снимка в outbox происходят в ОДНОЙ
     * SQLite-транзакции. Если процесс оборвётся, останутся либо обе записи, либо
     * ни одной — сервер никогда не пропустит локально сохранённое изменение.
     */
    @Synchronized
    fun save(payload: String, schemaVersion: Int): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        return try {
            if (!writeState(db, payload, schemaVersion)) return false
            val config = readSyncConfig(db)
            if (config != null && config.baseUrl.isNotBlank() && config.authToken.isNotBlank()) {
                // Every outbox row contains a complete state snapshot. Untried
                // intermediate snapshots are therefore superseded by this one.
                // Attempted rows stay until the server confirms their idempotency
                // key, so a lost response can never duplicate a mutation.
                db.delete("sync_outbox", "attempts = 0 AND conflict = 0", null)
                val outbox = ContentValues().apply {
                    put("mutation_id", UUID.randomUUID().toString())
                    put("payload", payload)
                    put("schema_version", schemaVersion)
                    put("created_at", System.currentTimeMillis())
                }
                if (db.insertOrThrow("sync_outbox", null, outbox) == -1L) return false
            }
            db.setTransactionSuccessful()
            true
        } catch (e: Exception) {
            Log.e(TAG, "save() failed; previous snapshot and outbox remain intact", e)
            false
        } finally {
            db.endTransaction()
        }
    }

    /** Применение серверного снимка не создаёт обратную мутацию и петлю sync. */
    @Synchronized
    fun saveRemote(payload: String, schemaVersion: Int, revision: Long): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        return try {
            if (!writeState(db, payload, schemaVersion)) return false
            db.execSQL(
                "UPDATE sync_config SET server_revision=?, last_sync_at=?, last_error=NULL WHERE id=1",
                arrayOf(revision, System.currentTimeMillis()),
            )
            db.setTransactionSuccessful()
            true
        } catch (e: Exception) {
            Log.e(TAG, "saveRemote() failed; local state was not replaced", e)
            false
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun load(): String? = readStateColumn("payload")

    @Synchronized
    fun loadBackup(): String? = readStateColumn("backup_payload")

    private fun readStateColumn(column: String): String? = try {
        readableDatabase.query(
            STATE_TABLE,
            arrayOf(column),
            "id = ?",
            arrayOf(ROW_ID.toString()),
            null,
            null,
            null,
        ).use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null }
    } catch (e: Exception) {
        Log.e(TAG, "read $column failed", e)
        null
    }

    @Synchronized
    fun configureSync(baseUrl: String, authToken: String) {
        val normalizedToken = authToken.trim()
        require(normalizedToken.length <= 8_192) { "Некорректный токен сервера" }
        val db = writableDatabase
        db.beginTransaction()
        var previousToken: String? = null
        try {
            val previous = readSyncConfig(db)
            previousToken = previous?.authToken
            if (normalizedToken.isBlank()) tokenVault.clear() else tokenVault.store(normalizedToken)
            val normalized = baseUrl.trimEnd('/')
            val newServer = previous == null || previous.baseUrl != normalized
            db.execSQL(
                "UPDATE sync_config SET base_url=?, auth_token=?, server_revision=CASE WHEN ? THEN 0 ELSE server_revision END, last_error=NULL WHERE id=1",
                arrayOf(normalized, "", if (newServer) 1 else 0),
            )
            // При первом подключении существующая локальная база обязательно
            // становится первой outbox-мутацией. Если сервер уже непустой,
            // получится безопасный conflict snapshot, а не тихая перезапись.
            if ((previous == null || previous.authToken.isBlank() || newServer) && pendingCount(db) == 0) {
                db.query(
                    STATE_TABLE,
                    arrayOf("payload", "schema_version"),
                    "id=1",
                    null,
                    null,
                    null,
                    null,
                ).use { c ->
                    if (c.moveToFirst()) {
                        val values = ContentValues().apply {
                            put("mutation_id", UUID.randomUUID().toString())
                            put("payload", c.getString(0))
                            put("schema_version", c.getInt(1))
                            put("created_at", System.currentTimeMillis())
                        }
                        db.insertOrThrow("sync_outbox", null, values)
                    }
                }
            }
            db.setTransactionSuccessful()
        } catch (error: Exception) {
            // SQLite and Android Keystore cannot share one transaction. Restore
            // the previous secret if the database part fails after encryption.
            val tokenToRestore = previousToken
            runCatching {
                if (tokenToRestore.isNullOrBlank()) tokenVault.clear()
                else tokenVault.store(tokenToRestore)
            }
            throw error
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun clearSyncAuth() {
        tokenVault.clear()
        writableDatabase.execSQL(
            "UPDATE sync_config SET auth_token='', last_error=NULL WHERE id=1",
        )
    }

    @Synchronized
    fun getSyncConfig(): SyncConfig? = readSyncConfig(readableDatabase)

    private fun readSyncConfig(db: SQLiteDatabase): SyncConfig? {
        var baseUrl = ""
        var legacyToken = ""
        var deviceId = ""
        var serverRevision = 0L
        val found = db.query(
            "sync_config",
            arrayOf("base_url", "auth_token", "device_id", "server_revision"),
            "id=1",
            null,
            null,
            null,
            null,
        ).use { c ->
            if (!c.moveToFirst()) false
            else {
                baseUrl = c.getString(0)
                legacyToken = c.getString(1)
                deviceId = c.getString(2)
                serverRevision = c.getLong(3)
                true
            }
        }
        if (!found) return null

        var secureToken = tokenVault.load()
        if (secureToken.isBlank() && legacyToken.isNotBlank()) {
            // One-time migration from v1.6 builds that stored the bearer token
            // in plain SQLite. Never fall back to keeping the plaintext value.
            tokenVault.store(legacyToken)
            secureToken = legacyToken
        }
        if (legacyToken.isNotBlank()) {
            db.execSQL("UPDATE sync_config SET auth_token='' WHERE id=1")
        }
        return SyncConfig(baseUrl, secureToken, deviceId, serverRevision)
    }

    @Synchronized
    fun claimNextPending(): PendingSnapshot? {
        val db = writableDatabase
        db.beginTransaction()
        return try {
            val pending = db.query(
                "sync_outbox",
                arrayOf("mutation_id", "payload", "schema_version", "attempts"),
                "conflict = 0",
                null,
                null,
                null,
                "created_at ASC",
                "1",
            ).use { c ->
                if (!c.moveToFirst()) null
                else PendingSnapshot(c.getString(0), c.getString(1), c.getInt(2), c.getInt(3) + 1)
            }
            if (pending != null) {
                db.execSQL(
                    "UPDATE sync_outbox SET attempts=? WHERE mutation_id=? AND conflict=0",
                    arrayOf(pending.attempts, pending.mutationId),
                )
            }
            db.setTransactionSuccessful()
            pending
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun pendingCount(): Int = pendingCount(readableDatabase)

    private fun pendingCount(db: SQLiteDatabase): Int = db.rawQuery(
        "SELECT COUNT(*) FROM sync_outbox",
        null,
    ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    @Synchronized
    fun sendablePendingCount(): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM sync_outbox WHERE conflict = 0",
        null,
    ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    @Synchronized
    fun nextPendingAttempt(): Int = readableDatabase.rawQuery(
        "SELECT attempts FROM sync_outbox WHERE conflict = 0 ORDER BY created_at ASC LIMIT 1",
        null,
    ).use { c -> if (c.moveToFirst()) c.getInt(0).coerceAtLeast(1) else 1 }

    @Synchronized
    fun markMutationApplied(mutationId: String, revision: Long) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("sync_outbox", "mutation_id=?", arrayOf(mutationId))
            db.execSQL(
                "UPDATE sync_config SET server_revision=?, last_sync_at=?, last_error=NULL WHERE id=1",
                arrayOf(revision, System.currentTimeMillis()),
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun markMutationConflicted(mutationId: String, error: String) {
        val message = error.take(1000)
        val db = writableDatabase
        db.execSQL(
            "UPDATE sync_outbox SET conflict=1, last_error=? WHERE mutation_id=?",
            arrayOf(message, mutationId),
        )
        db.execSQL("UPDATE sync_config SET last_error=? WHERE id=1", arrayOf(message))
    }

    @Synchronized
    fun conflictedMutationsJson(): String {
        val config = getSyncConfig()
        val result = JSONArray()
        readableDatabase.rawQuery(
            "SELECT rowid, mutation_id, created_at, COALESCE(last_error, '') FROM sync_outbox WHERE conflict=1 ORDER BY created_at ASC",
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result.put(JSONObject().apply {
                    put("id", cursor.getLong(0))
                    put("mutationId", cursor.getString(1))
                    put("deviceId", config?.deviceId ?: "")
                    put("baseRevision", config?.serverRevision ?: 0)
                    put("serverRevision", pendingRemoteSnapshot()?.second ?: config?.serverRevision ?: 0)
                    put("createdAt", cursor.getLong(2))
                    put("error", cursor.getString(3))
                })
            }
        }
        return result.toString()
    }

    @Synchronized
    fun discardConflictedMutation(localId: Long): Boolean =
        writableDatabase.delete("sync_outbox", "rowid=? AND conflict=1", arrayOf(localId.toString())) == 1

    @Synchronized
    fun requeueConflictedMutation(localId: Long): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        return try {
            var payload: String? = null
            var schemaVersion = 0
            db.rawQuery(
                "SELECT payload, schema_version FROM sync_outbox WHERE rowid=? AND conflict=1",
                arrayOf(localId.toString()),
            ).use { cursor ->
                if (cursor.moveToFirst()) {
                    payload = cursor.getString(0)
                    schemaVersion = cursor.getInt(1)
                }
            }
            if (payload == null) return false
            db.delete("sync_outbox", "rowid=? AND conflict=1", arrayOf(localId.toString()))
            val values = ContentValues().apply {
                put("mutation_id", UUID.randomUUID().toString())
                put("payload", payload)
                put("schema_version", schemaVersion)
                put("created_at", System.currentTimeMillis())
                put("attempts", 0)
                put("conflict", 0)
            }
            if (db.insertOrThrow("sync_outbox", null, values) == -1L) return false
            db.setTransactionSuccessful()
            true
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun savePendingRemoteSnapshot(payload: String, revision: Long) {
        val values = ContentValues().apply {
            put("id", ROW_ID)
            put("payload", payload)
            put("revision", revision)
            put("received_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict(
            "sync_remote_pending",
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    @Synchronized
    fun pendingRemoteSnapshot(): Pair<String, Long>? = readableDatabase.rawQuery(
        "SELECT payload, revision FROM sync_remote_pending WHERE id=1",
        null,
    ).use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) to cursor.getLong(1) else null
    }

    @Synchronized
    fun clearPendingRemoteSnapshot() {
        writableDatabase.delete("sync_remote_pending", "id=1", null)
    }

    @Synchronized
    fun updateServerRevision(revision: Long) {
        writableDatabase.execSQL(
            "UPDATE sync_config SET server_revision=? WHERE id=1",
            arrayOf(revision),
        )
    }

    @Synchronized
    fun markSyncError(mutationId: String?, error: String) {
        val db = writableDatabase
        db.execSQL("UPDATE sync_config SET last_error=? WHERE id=1", arrayOf(error.take(1000)))
        if (mutationId != null) {
            db.execSQL(
                "UPDATE sync_outbox SET last_error=? WHERE mutation_id=?",
                arrayOf(error.take(1000), mutationId),
            )
        }
    }

    @Synchronized
    fun syncStatusJson(): String {
        val cfg = getSyncConfig()
        return JSONObject().apply {
            put("configured", cfg != null && cfg.baseUrl.isNotBlank() && cfg.authToken.isNotBlank())
            put("baseUrl", cfg?.baseUrl ?: "")
            put("deviceId", cfg?.deviceId ?: "")
            put("serverRevision", cfg?.serverRevision ?: 0)
            put("pending", pendingCount())
            put("conflicts", pendingCount() - sendablePendingCount())
            readableDatabase.query(
                "sync_config",
                arrayOf("last_sync_at", "last_error"),
                "id=1",
                null,
                null,
                null,
                null,
            ).use { c ->
                if (c.moveToFirst()) {
                    put("lastSyncAt", if (c.isNull(0)) JSONObject.NULL else c.getLong(0))
                    put("lastError", if (c.isNull(1)) JSONObject.NULL else c.getString(1))
                }
            }
        }.toString()
    }
}

private class SyncTokenVault(context: Context) {
    companion object {
        private const val KEY_ALIAS = "treshka_sync_token_v1"
        private const val PREFS = "treshka_secure_sync"
        private const val IV = "token_iv"
        private const val VALUE = "token_value"
    }

    private val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            generateKey()
        }
    }

    fun store(token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        check(
            preferences.edit()
                .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(VALUE, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .commit()
        ) { "Не удалось безопасно сохранить токен" }
    }

    fun load(): String {
        val iv = preferences.getString(IV, null) ?: return ""
        val encrypted = preferences.getString(VALUE, null) ?: return ""
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (error: Exception) {
            Log.e("SyncTokenVault", "Stored token cannot be decrypted", error)
            clear()
            ""
        }
    }

    fun clear() {
        preferences.edit().remove(IV).remove(VALUE).apply()
    }
}
