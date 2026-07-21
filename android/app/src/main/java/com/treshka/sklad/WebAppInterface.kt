package com.treshka.sklad

import android.webkit.JavascriptInterface

/**
 * Мост "прототип (JS) ↔ нативное хранилище (SQLite)" для окна `window.AndroidStorage`
 * в prototype.html (см. serializeAppState()/flushSave()/loadAppStateOnStart()).
 *
 * Методы, помеченные @JavascriptInterface, WebView вызывает в отдельном потоке,
 * НЕ блокируя UI, но вызов из JavaScript при этом остаётся синхронным — ровно то,
 * что нужно прототипу: `bridge.saveState(json, version)` и `bridge.loadState()`
 * выполняются как обычные синхронные функции, без Promise/callback на JS-стороне.
 */
class WebAppInterface(private val store: AppStateStore) {

    @JavascriptInterface
    fun saveState(json: String, schemaVersion: Int): Boolean {
        return store.save(json, schemaVersion)
    }

    @JavascriptInterface
    fun loadState(): String {
        // JS ожидает строку ("null" при отсутствии сохранённых данных) —
        // @JavascriptInterface не пропускает настоящий null через мост стабильно
        // на всех версиях WebView, поэтому явный текстовый sentinel безопаснее.
        return store.load() ?: "null"
    }

    @JavascriptInterface
    fun loadBackupState(): String {
        return store.loadBackup() ?: "null"
    }
}
