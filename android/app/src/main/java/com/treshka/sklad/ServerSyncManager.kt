package com.treshka.sklad

import android.util.Log
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
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
    private val executor = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)

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
        val config = store.getSyncConfig() ?: error("Сервер не настроен")
        val response = requestJson("${config.baseUrl}/v1/sync/conflicts", "GET", config.authToken, null)
        if (response.code !in 200..299) throw IllegalStateException("HTTP ${response.code}: ${response.body.take(300)}")
        return response.body
    }

    fun resolveConflict(id: Long, decision: String): String {
        require(decision == "local" || decision == "server")
        val config = store.getSyncConfig() ?: error("Сервер не настроен")
        val body = JSONObject().put("decision", decision).toString()
        val response = requestJson("${config.baseUrl}/v1/sync/conflicts/$id/resolve", "POST", config.authToken, body)
        if (response.code !in 200..299) throw IllegalStateException("HTTP ${response.code}: ${response.body.take(300)}")
        syncNow()
        return response.body
    }

    fun registerPushToken(token: String): Boolean {
        val config = store.getSyncConfig() ?: return false
        val body = JSONObject().put("deviceId", config.deviceId).put("pushToken", token).toString()
        return requestJson("${config.baseUrl}/v1/devices/register", "POST", config.authToken, body).code in 200..299
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
            val pending = store.nextPending() ?: break
            val request = JSONObject().apply {
                put("mutationId", pending.mutationId)
                put("deviceId", config.deviceId)
                put("baseRevision", config.serverRevision)
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
                store.markSyncError(pending.mutationId, "Конфликт версий: локальные данные сохранены в очереди и не перезаписаны")
                return
            }
            if (response.code !in 200..299) {
                store.markSyncError(pending.mutationId, "HTTP ${response.code}: ${response.body.take(300)}")
                return
            }
            val revision = JSONObject(response.body).getLong("revision")
            store.markMutationApplied(pending.mutationId, revision)
            config = store.getSyncConfig() ?: return
        }

        // Серверный снимок применяется только при пустом outbox. Поэтому
        // несинхронизированные локальные изменения никогда не затираются pull-ом.
        if (store.pendingCount() == 0) {
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
                    onRemoteState(json.getJSONObject("payload").toString(), json.getLong("revision"))
                }
            } else if (response.code !in 200..299) {
                store.markSyncError(null, "Pull HTTP ${response.code}")
            }
        }
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
