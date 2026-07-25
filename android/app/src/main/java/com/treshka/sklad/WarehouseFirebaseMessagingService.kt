package com.treshka.sklad

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class WarehouseFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val store = AppStateStore(this)
        val sync = ServerSyncManager(store, {}, { _, _ -> })
        sync.registerPushToken(token)
    }

    override fun onDeletedMessages() {
        val store = AppStateStore(this)
        ServerSyncManager(store, {}, { _, _ -> }).syncNow()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "ТРЁШКА склад"
        val body = message.notification?.body ?: message.data["body"] ?: "Новое событие"
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(MainActivity.NOTIFICATION_CHANNEL_ID, "События склада", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, MainActivity.NOTIFICATION_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        manager.notify(
            (System.currentTimeMillis() and 0x7fffffff).toInt(),
            builder.setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .build(),
        )
    }
}
