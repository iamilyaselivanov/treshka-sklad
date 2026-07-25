package com.treshka.sklad

import android.content.Context
import org.json.JSONObject
import java.util.UUID

class PushRegistrationStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("treshka_push", Context.MODE_PRIVATE)

    fun saveToken(token: String) {
        preferences.edit().putString(KEY_TOKEN, token.trim()).apply()
    }

    fun registrationJson(): String {
        val deviceId = preferences.getString(KEY_DEVICE_ID, null)
            ?: UUID.randomUUID().toString().also {
                preferences.edit().putString(KEY_DEVICE_ID, it).apply()
            }
        val versionName = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
        return JSONObject()
            .put("deviceId", deviceId)
            .put("token", preferences.getString(KEY_TOKEN, "") ?: "")
            .put("platform", "android")
            .put("appVersion", versionName)
            .toString()
    }

    companion object {
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_TOKEN = "fcm_token"
    }
}
