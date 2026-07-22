package com.treshka.sklad

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log

/**
 * Локальное офлайн-хранилище состояния склада (пункт #1 ревью, P0).
 *
 * Архитектурная позиция (см. "Твои требования" пользователя): это НЕ финальный
 * источник правды — в перспективе состояние должно синхронизироваться с сервером.
 * Здесь реализован надёжный локальный слой на стороне Android:
 *  - весь JS-стейт (склад/посты/документы/выдачи/журнал) сериализуется в JSON
 *    на стороне WebView (см. serializeAppState() в prototype.html) и сохраняется
 *    сюда одной транзакцией;
 *  - перед перезаписью текущая версия копируется в резервный слот (`backup_*`),
 *    так что сбой записи или падение приложения сразу после сохранения не могут
 *    уничтожить единственную копию данных;
 *  - версия схемы (`schema_version`) хранится вместе с данными — миграция самой
 *    структуры данных выполняется на стороне JS (см. STATE_MIGRATIONS), эта
 *    таблица лишь передаёт версию и "сырой" JSON без интерпретации.
 *
 * Хранится один "текущий" снимок (id=1) — состояние склада не бьётся на строки
 * построчно, потому что источник правды в этой версии — JS-модель целиком.
 */
class AppStateStore(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val TAG = "AppStateStore"
        private const val DB_NAME = "sklad_state.db"
        private const val DB_VERSION = 1
        private const val TABLE = "app_state"
        private const val COL_ID = "id"
        private const val COL_SCHEMA_VERSION = "schema_version"
        private const val COL_PAYLOAD = "payload"
        private const val COL_UPDATED_AT = "updated_at"
        private const val COL_BACKUP_SCHEMA_VERSION = "backup_schema_version"
        private const val COL_BACKUP_PAYLOAD = "backup_payload"
        private const val COL_BACKUP_UPDATED_AT = "backup_updated_at"
        private const val ROW_ID = 1L
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE (
                $COL_ID INTEGER PRIMARY KEY,
                $COL_SCHEMA_VERSION INTEGER NOT NULL,
                $COL_PAYLOAD TEXT NOT NULL,
                $COL_UPDATED_AT INTEGER NOT NULL,
                $COL_BACKUP_SCHEMA_VERSION INTEGER,
                $COL_BACKUP_PAYLOAD TEXT,
                $COL_BACKUP_UPDATED_AT INTEGER
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Схема этой таблицы (не путать со schema_version данных склада внутри payload)
        // пока не менялась. Когда понадобится — миграции добавляются здесь, БЕЗ DROP TABLE,
        // чтобы апдейт приложения никогда не уничтожал уже накопленные складские данные.
    }

    /**
     * Сохраняет [payload] (JSON-сериализация всего состояния склада) одной транзакцией.
     * Текущая запись (если есть) сначала переносится в резервные колонки, поэтому
     * даже сбой ровно на этой операции оставляет либо старое, либо новое состояние
     * полностью читаемым — никогда полупустое.
     */
    @Synchronized
    fun save(payload: String, schemaVersion: Int): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val existing = db.query(
                TABLE, arrayOf(COL_SCHEMA_VERSION, COL_PAYLOAD, COL_UPDATED_AT),
                "$COL_ID = ?", arrayOf(ROW_ID.toString()), null, null, null
            )
            val values = ContentValues()
            existing.use { c ->
                if (c.moveToFirst()) {
                    values.put(COL_BACKUP_SCHEMA_VERSION, c.getInt(0))
                    values.put(COL_BACKUP_PAYLOAD, c.getString(1))
                    values.put(COL_BACKUP_UPDATED_AT, c.getLong(2))
                }
            }
            values.put(COL_ID, ROW_ID)
            values.put(COL_SCHEMA_VERSION, schemaVersion)
            values.put(COL_PAYLOAD, payload)
            values.put(COL_UPDATED_AT, System.currentTimeMillis())
            // #10 ревью: insertWithOnConflict() может вернуть -1 при ошибке —
            // раньше результат игнорировался, и мы всё равно помечали транзакцию
            // успешной и возвращали true, хотя запись могла не произойти.
            val rowId = db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
            if (rowId == -1L) {
                Log.e(TAG, "save() failed: insertWithOnConflict() вернул -1, транзакция НЕ помечена успешной")
                return false
            }
            db.setTransactionSuccessful()
            return true
        } catch (e: Exception) {
            Log.e(TAG, "save() failed, предыдущее состояние осталось нетронутым", e)
            return false
        } finally {
            db.endTransaction()
        }
    }

    /** Возвращает текущий сохранённый JSON или null, если сохранений ещё не было (первый запуск). */
    @Synchronized
    fun load(): String? {
        return try {
            readableDatabase.query(
                TABLE, arrayOf(COL_PAYLOAD),
                "$COL_ID = ?", arrayOf(ROW_ID.toString()), null, null, null
            ).use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (e: Exception) {
            Log.e(TAG, "load() failed", e)
            null
        }
    }

    /**
     * Резервная копия предыдущего сохранения — на случай, если основная запись
     * оказалась повреждена (например, из-за ручного вмешательства во внешнее
     * хранилище) и её не удалось разобрать на стороне JS.
     */
    @Synchronized
    fun loadBackup(): String? {
        return try {
            readableDatabase.query(
                TABLE, arrayOf(COL_BACKUP_PAYLOAD),
                "$COL_ID = ?", arrayOf(ROW_ID.toString()), null, null, null
            ).use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (e: Exception) {
            Log.e(TAG, "loadBackup() failed", e)
            null
        }
    }
}
