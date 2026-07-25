package com.treshka.sklad

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import org.json.JSONObject
import java.util.UUID

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
        private const val DB_VERSION = 3
        private const val STATE_TABLE = "app_state"
        private const val ROW_ID = 1L

        /**
         * Сколько конфликтных снимков хранить. Каждая строка outbox — ПОЛНЫЙ
         * снимок состояния, поэтому более старые конфликтные записи полностью
         * перекрываются более новыми и нужны только для разбора инцидента.
         * Без этого лимита таблица росла бы неограниченно.
         */
        private const val CONFLICT_HISTORY_LIMIT = 20
    }

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
        if (oldVersion < 3) addConflictColumn(db)
    }

    /**
     * v3 добавляет пометку конфликта. ALTER TABLE обёрнут в try/catch, потому что
     * на устройствах, где sync_outbox создавалась уже новым CREATE TABLE (свежая
     * установка с промежуточной версией), колонка уже существует и SQLite
     * ответит "duplicate column name". Это не ошибка обновления.
     */
    private fun addConflictColumn(db: SQLiteDatabase) {
        try {
            db.execSQL("ALTER TABLE sync_outbox ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0")
        } catch (e: Exception) {
            Log.i(TAG, "sync_outbox.conflict already present", e)
        }
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
                last_error TEXT,
                conflict INTEGER NOT NULL DEFAULT 0
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
        val db = writableDatabase
        db.beginTransaction()
        try {
            val previous = readSyncConfig(db)
            val normalized = baseUrl.trimEnd('/')
            val newServer = previous == null || previous.baseUrl != normalized
            db.execSQL(
                "UPDATE sync_config SET base_url=?, auth_token=?, server_revision=CASE WHEN ? THEN 0 ELSE server_revision END, last_error=NULL WHERE id=1",
                arrayOf(normalized, authToken, if (newServer) 1 else 0),
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
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun clearSyncAuth() {
        writableDatabase.execSQL(
            "UPDATE sync_config SET auth_token='', last_error=NULL WHERE id=1",
        )
    }

    @Synchronized
    fun getSyncConfig(): SyncConfig? = readSyncConfig(readableDatabase)

    private fun readSyncConfig(db: SQLiteDatabase): SyncConfig? = db.query(
        "sync_config",
        arrayOf("base_url", "auth_token", "device_id", "server_revision"),
        "id=1",
        null,
        null,
        null,
        null,
    ).use { c ->
        if (!c.moveToFirst()) null else SyncConfig(c.getString(0), c.getString(1), c.getString(2), c.getLong(3))
    }

    /** Конфликтные снимки к отправке не предлагаются: повтор даст тот же 409. */
    @Synchronized
    fun nextPending(): PendingSnapshot? = readableDatabase.query(
        "sync_outbox",
        arrayOf("mutation_id", "payload", "schema_version"),
        "conflict = 0",
        null,
        null,
        null,
        "created_at ASC",
        "1",
    ).use { c ->
        if (!c.moveToFirst()) null else PendingSnapshot(c.getString(0), c.getString(1), c.getInt(2))
    }

    @Synchronized
    fun pendingCount(): Int = pendingCount(readableDatabase)

    private fun pendingCount(db: SQLiteDatabase): Int = db.rawQuery(
        "SELECT COUNT(*) FROM sync_outbox WHERE conflict = 0",
        null,
    ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /** Число неразрешённых конфликтов — выносится в UI, см. syncStatusJson(). */
    @Synchronized
    fun conflictCount(): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM sync_outbox WHERE conflict = 1",
        null,
    ).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /**
     * Сервер ответил 409 на снимок [mutationId]. Раньше запись просто оставалась
     * в очереди: следующий цикл брал её же, снова получал 409, очередь никогда не
     * пустела, а pull был закрыт условием pendingCount() == 0 — устройство
     * навсегда застревало на устаревших остатках и долбило /v1/sync/push.
     *
     * Теперь конфликтными помечаются ВСЕ накопленные снимки: они построены от той
     * же устаревшей baseRevision, поэтому каждый из них получил бы тот же 409.
     * Ничего не удаляется — payload остаётся целиком и восстанавливается через
     * разрешение конфликта. Очередь активных записей пустеет, значит pull снова
     * работает и устройство видит актуальные данные.
     */
    @Synchronized
    fun markQueueConflicted(mutationId: String, error: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL(
                "UPDATE sync_outbox SET attempts = attempts + 1 WHERE mutation_id = ?",
                arrayOf(mutationId),
            )
            db.execSQL(
                "UPDATE sync_outbox SET conflict = 1, last_error = ? WHERE conflict = 0",
                arrayOf(error.take(1000)),
            )
            db.execSQL("UPDATE sync_config SET last_error = ? WHERE id = 1", arrayOf(error.take(1000)))
            // Каждая строка — полный снимок, поэтому старые конфликты полностью
            // перекрыты новыми и хранятся только для разбора.
            db.execSQL(
                """
                DELETE FROM sync_outbox WHERE conflict = 1 AND mutation_id NOT IN (
                    SELECT mutation_id FROM sync_outbox WHERE conflict = 1
                    ORDER BY created_at DESC LIMIT $CONFLICT_HISTORY_LIMIT
                )
                """.trimIndent()
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Конфликт разрешён на сервере. Серверная сторона хранит присланный снимок и
     * применяет выбранное решение сама, поэтому локальная копия в очереди —
     * дубликат: и при "local", и при "server" актуальное состояние приедет
     * ближайшим pull-ом. Вызывать ТОЛЬКО после успешного ответа сервера.
     */
    @Synchronized
    fun dropConflicted() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("sync_outbox", "conflict = 1", null)
            db.execSQL("UPDATE sync_config SET last_error = NULL WHERE id = 1")
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

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
    fun markSyncError(mutationId: String?, error: String) {
        val db = writableDatabase
        db.execSQL("UPDATE sync_config SET last_error=? WHERE id=1", arrayOf(error.take(1000)))
        if (mutationId != null) {
            db.execSQL(
                "UPDATE sync_outbox SET attempts=attempts+1,last_error=? WHERE mutation_id=?",
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
            // Конфликты выводятся отдельно: pull теперь идёт и при непустой
            // конфликтной очереди, поэтому пользователь обязан видеть, что часть
            // его правок ждёт решения, а не считать экран актуальным.
            put("conflicts", conflictCount())
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
