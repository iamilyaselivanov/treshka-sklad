package com.treshka.sklad

import android.util.Log
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Последовательно отправляет durable outbox. Повтор одного mutationId безопасен:
 * сервер хранит idempotency key и возвращает уже применённую revision.
 */
class ServerSyncManager(
    private val store: AppStateStore,
    private val onStatus: (String) -> Unit,
    private val onRemoteState: (String, Long) -> Unit,
) {
    companion object { private const val TAG = "ServerSync" }
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val running = AtomicBoolean(false)
    private val retryScheduled = AtomicBoolean(false)

    fun login(baseUrl: String, login: String, password: String): String {
        val normalized = baseUrl.trim().trimEnd('/')
        require(normalized.startsWith("https://")) { "Сервер должен использовать HTTPS" }
        val body = JSONObject().put("login", login).put("password", password).toString()
        val response = requestJson("$normalized/v1/auth/login", "POST", null, body)
        if (response.code !in 200..299) throw IllegalStateException("HTTP ${response.code}: ${response.body.take(300)}")
        val token = JSONObject(response.body).getString("token")
        store.configureSync(normalized, token)
        syncNow()
        return response.body
    }

    fun createUser(json: String): String {
        val config = store.getSyncConfig() ?: error("Сервер не настроен")
        val response = requestJson("${config.baseUrl}/v1/users", "POST", config.authToken, json)
        if (response.code !in 200..299) throw IllegalStateException("HTTP ${response.code}: ${response.body.take(300)}")
        return response.body
    }

    fun listConflicts(): String {
        return store.conflictedMutationsJson()
    }

    fun resolveConflict(id: Long, decision: String): String {
        require(decision == "local" || decision == "server")
        val config = store.getSyncConfig() ?: error("Сервер не настроен")
        if (decision == "server") {
            check(store.discardConflictedMutation(id)) { "Локальный конфликт не найден" }
            if (store.pendingCount() == 0) {
                store.pendingRemoteSnapshot()?.let { (payload, revision) ->
                    onRemoteState(payload, revision)
                    store.clearPendingRemoteSnapshot()
                }
            }
        } else {
            var remote = store.pendingRemoteSnapshot()
            if (remote == null) {
                val response = requestJson(
                    "${config.baseUrl}/v1/sync/pull?afterRevision=0",
                    "GET",
                    config.authToken,
                    null,
                )
                if (response.code !in 200..299) {
                    throw IllegalStateException("Pull HTTP ${response.code}: ${response.body.take(300)}")
                }
                val json = JSONObject(response.body)
                if (json.has("payload") && json.has("revision")) {
                    remote = json.getJSONObject("payload").toString() to json.getLong("revision")
                    store.savePendingRemoteSnapshot(remote.first, remote.second)
                }
            }
            val authoritative = remote
                ?: throw IllegalStateException(
                    "Сервер не вернул полный актуальный снимок. Конфликт и обе версии сохранены; повторите позже",
                )
            when (store.requeueConflictedMutation(id, authoritative.second)) {
                ConflictRequeueResult.REQUEUED -> Unit
                ConflictRequeueResult.MISSING ->
                    throw IllegalStateException("Локальный конфликт не найден")
                ConflictRequeueResult.SERVER_ADVANCED ->
                    throw IllegalStateException(
                        "Локальный снимок устарел и не может заменить более новую серверную версию. " +
                            "Выберите серверную версию; локальная копия останется в резервной базе устройства",
                    )
                ConflictRequeueResult.INVALID_REMOTE_REVISION ->
                    throw IllegalStateException(
                        "Получена некорректная ревизия сервера. Конфликт и обе версии сохранены",
                    )
            }
        }
        syncNow()
        return JSONObject().put("ok", true).put("decision", decision).toString()
    }

    fun registerPushToken(token: String): Boolean {
        val config = store.getSyncConfig() ?: return false
        if (token.isBlank()) return false
        val body = JSONObject().put("deviceId", config.deviceId).put("pushToken", token).toString()
        // Firebase invokes its success callback on the main thread. Network I/O
        // here used to freeze or crash the Activity with NetworkOnMainThread.
        executor.execute {
            try {
                val response = requestJson("${config.baseUrl}/v1/devices/register", "POST", config.authToken, body)
                if (response.code !in 200..299) {
                    Log.w(TAG, "push token registration HTTP ${response.code}")
                } else if (runCatching { JSONObject(response.body).optBoolean("evictedOldest", false) }.getOrDefault(false)) {
                    Log.w(TAG, "oldest push device was evicted because the account reached its device limit")
                }
            } catch (error: Exception) {
                Log.w(TAG, "push token registration failed", error)
            }
        }
        return true
    }

    fun uploadImage(dataUrl: String): String {
        val config = store.getSyncConfig() ?: error("Сервер не настроен")
        val encoded = dataUrl.substringAfter(',', "")
        require(encoded.isNotBlank()) { "Некорректное изображение" }
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        val boundary = "Treshka${System.currentTimeMillis()}"
        val connection = (URL("${config.baseUrl}/v1/media/images").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer ${config.authToken}")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        connection.outputStream.use { out ->
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\n".toByteArray())
            out.write("Content-Type: image/jpeg\r\n\r\n".toByteArray())
            out.write(bytes)
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }
        return try {
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) error("HTTP $code: ${body.take(300)}")
            body
        } finally {
            connection.disconnect()
        }
    }

    fun syncNow() {
        if (!running.compareAndSet(false, true)) return
        executor.execute {
            try {
                syncLoop()
            } catch (e: Exception) {
                Log.e(TAG, "sync failed", e)
                store.markSyncError(null, e.message ?: "Ошибка синхронизации")
                scheduleRetry(store.nextPendingAttempt())
            } finally {
                running.set(false)
                onStatus(store.syncStatusJson())
            }
        }
    }

    private fun syncLoop() {
        var config = store.getSyncConfig() ?: return
        if (config.baseUrl.isBlank() || config.authToken.isBlank()) return
        while (true) {
            // Claim and increment attempts in one SQLite transaction. A
            // concurrent save can no longer compact the row after we selected
            // it but before the request starts.
            val pending = store.claimNextPending() ?: break
            val request = JSONObject().apply {
                put("mutationId", pending.mutationId)
                put("deviceId", config.deviceId)
                put("baseRevision", pending.baseRevision)
                put("schemaVersion", pending.schemaVersion)
                put("payload", JSONObject(pending.payload))
            }
            val response = requestJson(
                "${config.baseUrl}/v1/sync/push",
                "POST",
                config.authToken,
                request.toString(),
            )
            if (response.code == 409) {
                val message = "Конфликт версий: локальные данные сохранены отдельно и не перезаписаны"
                store.markMutationConflicted(pending.mutationId, message)
                // A conflict requires an explicit user decision. Automatically
                // releasing it with the same stale baseRevision creates an
                // endless 409 loop and must never enable pull over local work.
                break
            }
            if (response.code !in 200..299) {
                val message = "HTTP ${response.code}: ${response.body.take(300)}"
                val retryable = response.code == 408
                    || response.code == 425
                    || response.code == 429
                    || response.code >= 500
                if (retryable) {
                    store.markSyncError(pending.mutationId, message)
                    scheduleRetry(pending.attempts)
                    return
                }
                // A permanent 4xx must leave the FIFO lane and become a visible,
                // explicitly resolvable conflict. Otherwise the same rejected
                // row blocks every newer snapshot forever.
                store.markMutationConflicted(pending.mutationId, message)
                if (response.code == 401 || response.code == 403) break
                continue
            }
            val revision = JSONObject(response.body).getLong("revision")
            store.markMutationApplied(pending.mutationId, revision)
            config = store.getSyncConfig() ?: return
        }

        // Pull may continue while only parked conflicts remain, but the remote
        // payload is cached separately and never overwrites local work until an
        // administrator explicitly chooses a version.
        if (store.sendablePendingCount() == 0) {
            config = store.getSyncConfig() ?: return
            val response = requestJson(
                "${config.baseUrl}/v1/sync/pull?afterRevision=${config.serverRevision}",
                "GET",
                config.authToken,
                null,
            )
            if (response.code == 200) {
                val json = JSONObject(response.body)
                if (!json.optBoolean("unchanged", false) && json.has("payload")) {
                    val payload = json.getJSONObject("payload").toString()
                    val revision = json.getLong("revision")
                    if (store.pendingCount() > 0) {
                        store.savePendingRemoteSnapshot(payload, revision)
                    } else {
                        store.clearPendingRemoteSnapshot()
                        onRemoteState(payload, revision)
                    }
                }
            } else if (response.code !in 200..299) {
                store.markSyncError(null, "Pull HTTP ${response.code}")
            }
        }
    }

    private fun scheduleRetry(attempt: Int) {
        if (!retryScheduled.compareAndSet(false, true)) return
        val exponent = (attempt - 1).coerceIn(0, 6)
        val delaySeconds = (5L * (1L shl exponent)).coerceAtMost(300L)
        executor.schedule({
            retryScheduled.set(false)
            syncNow()
        }, delaySeconds, TimeUnit.SECONDS)
    }

    private data class HttpResult(val code: Int, val body: String)

    private fun requestJson(url: String, method: String, token: String?, body: String?): HttpResult {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
        }
        return try {
            val code = connection.responseCode
            val stream = if (code in 200..399) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            HttpResult(code, text)
        } finally {
            connection.disconnect()
        }
    }
}
