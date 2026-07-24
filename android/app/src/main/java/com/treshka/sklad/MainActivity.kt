package com.treshka.sklad

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.Dialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

private const val APP_URL = "https://sklad-ok-prototype.janfoody2016.chatgpt.site/"
private const val APP_HOST = "sklad-ok-prototype.janfoody2016.chatgpt.site"

/**
 * ТРЁШКА склад — нативная Android-обёртка над однофайловым HTML/JS прототипом
 * (public/prototype.html), загружаемым из assets. Вся бизнес-логика
 * (склад, посты, документы, выдачи, роли, инвентаризация, QR) реализована
 * в самом прототипе; эта Activity — полноэкранный WebView плюс нативные мосты в JS:
 *  - window.AndroidStorage — сохранение/загрузка всего состояния склада в SQLite
 *    (см. AppStateStore.kt/WebAppInterface.kt) — решает P0 "данные не должны
 *    теряться при обновлении приложения";
 *  - window.AndroidScanner — реальное сканирование QR камерой устройства через
 *    CameraX + ML Kit (см. QrScanActivity.kt) вместо демо-заглушки;
 *  - window.AndroidFiles — сохранение выгруженных .xlsx на устройство через
 *    MediaStore/Downloads (раньше Blob+<a download> в WebView не сохранял файл
 *    вовсе, но UI утверждал обратное — #3 ревью);
 *  - window.AndroidPrint — печать через системный PrintManager
 *    (WebView не реализует window.print() — #4 ревью).
 *  - window.AndroidPhoto — прикрепление фото к карточке товара камерой устройства
 *    или из галереи (WebView не показывает системный file picker без
 *    onShowFileChooser/нативного моста — обычный <input type=file> внутри
 *    приложения молча ничего не делает).
 */
class MainActivity : AppCompatActivity() {
    companion object {
        const val NOTIFICATION_CHANNEL_ID = "treshka_sklad_events"
    }

    private lateinit var webView: WebView
    private lateinit var appStateStore: AppStateStore
    private lateinit var serverSyncManager: ServerSyncManager

    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val value = result.data?.getStringExtra(QrScanActivity.EXTRA_RESULT_VALUE)
            if (value != null) {
                webView.evaluateJavascript(
                    "window.onNativeScanResult && window.onNativeScanResult(${jsStringLiteral(value)});",
                    null
                )
            } else {
                webView.evaluateJavascript(
                    "window.onNativeScanError && window.onNativeScanError('Пустой результат сканирования');",
                    null
                )
            }
        } else {
            // #12 ревью: раньше отмена пользователем, отказ в разрешении на камеру
            // и сбой запуска камеры одинаково превращались в "Сканирование
            // отменено" — теперь причина различается и доходит до пользователя.
            val reason = result.data?.getStringExtra(QrScanActivity.EXTRA_CANCEL_REASON)
            val message = when (reason) {
                QrScanActivity.REASON_PERMISSION_DENIED -> "Нет разрешения на использование камеры"
                QrScanActivity.REASON_CAMERA_ERROR -> "Не удалось запустить камеру устройства"
                else -> "Сканирование отменено"
            }
            webView.evaluateJavascript(
                "window.onNativeScanError && window.onNativeScanError(${jsStringLiteral(message)});",
                null
            )
        }
    }

    // --- Фото карточки товара (window.AndroidPhoto, см. PhotoBridge ниже) ---
    // itemId, для которого сейчас идёт выбор источника фото — нужен, потому что
    // между pickPhoto(itemId) и приходом результата из ActivityResultLauncher
    // проходит асинхронный переход в другое приложение (камера/галерея), и
    // сам launcher.launch() не может пронести itemId иначе, чем через это поле.
    private var pendingPhotoItemId: String? = null
    private var pendingCameraPermissionItemId: String? = null

    private val cameraPhotoLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val itemId = pendingPhotoItemId
        pendingPhotoItemId = null
        if (itemId == null) return@registerForActivityResult
        if (result.resultCode == RESULT_OK) {
            @Suppress("DEPRECATION")
            val bitmap = result.data?.extras?.get("data") as? Bitmap
            if (bitmap != null) deliverPhoto(itemId, bitmap)
            else deliverPhotoError(itemId, "Не удалось получить снимок с камеры")
        } else {
            deliverPhotoError(itemId, "Съёмка отменена")
        }
    }

    private val galleryPhotoLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        val itemId = pendingPhotoItemId
        pendingPhotoItemId = null
        if (itemId == null) return@registerForActivityResult
        if (uri == null) {
            deliverPhotoError(itemId, "Выбор фото отменён")
            return@registerForActivityResult
        }
        try {
            // Раньше здесь была BitmapFactory.decodeStream(it) без опций — фото из
            // галереи (нередко 12+ Мп с современных камер) декодировалось В ПОЛНОМ
            // разрешении в память, и только ПОТОМ deliverPhoto() ужимало его до 640px.
            // На слабых устройствах/при большом фото это могло привести к OutOfMemory
            // ещё до того, как урезанная версия вообще была бы создана. Теперь сначала
            // читаются только размеры (inJustDecodeBounds), считается inSampleSize —
            // и декодируется сразу уменьшенная битовая карта.
            val bitmap = decodeSampledBitmapFromUri(uri, 640)
            if (bitmap != null) deliverPhoto(itemId, bitmap)
            else deliverPhotoError(itemId, "Не удалось прочитать выбранное изображение")
        } catch (e: Exception) {
            Log.e("PhotoBridge", "gallery pick failed", e)
            deliverPhotoError(itemId, "Ошибка чтения изображения")
        }
    }

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val itemId = pendingCameraPermissionItemId
        pendingCameraPermissionItemId = null
        if (itemId == null) return@registerForActivityResult
        if (granted) {
            pendingPhotoItemId = itemId
            cameraPhotoLauncher.launch(Intent(MediaStore.ACTION_IMAGE_CAPTURE))
        } else {
            deliverPhotoError(itemId, "Нет разрешения на использование камеры")
        }
    }

    // Разрешение на запись во внешнее хранилище нужно только на API 26-28
    // (Android 8-9): начиная с API 29 (Q) запись в коллекцию MediaStore.Downloads
    // не требует WRITE_EXTERNAL_STORAGE. Запрашиваем один раз при старте, чтобы
    // экспорт в Excel не падал молча на старых устройствах.
    private val requestStoragePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* результат неважен: saveExportedFile() сам проверит и вернёт false при отказе */ }
    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* уведомления также остаются во внутреннем центре приложения */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        appStateStore = AppStateStore(this)
        createNotificationChannel()

        webView = WebView(this)
        setContentView(webView)
        serverSyncManager = ServerSyncManager(
            appStateStore,
            onStatus = { json ->
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onNativeSyncStatus && window.onNativeSyncStatus(${jsStringLiteral(json)});",
                        null,
                    )
                }
            },
            onRemoteState = { payload, revision ->
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onNativeRemoteState && window.onNativeRemoteState(${jsStringLiteral(payload)}, $revision);",
                        null,
                    )
                }
            },
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            allowFileAccess = false
            allowContentAccess = false
        }

        webView.addJavascriptInterface(WebAppInterface(appStateStore, serverSyncManager), "AndroidStorage")
        webView.addJavascriptInterface(SyncBridge(), "AndroidSync")
        webView.addJavascriptInterface(ScannerBridge(), "AndroidScanner")
        webView.addJavascriptInterface(FileExportBridge(), "AndroidFiles")
        webView.addJavascriptInterface(PrintBridge(), "AndroidPrint")
        webView.addJavascriptInterface(PhotoBridge(), "AndroidPhoto")
        webView.addJavascriptInterface(NotificationBridge(), "AndroidNotifications")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val uri = request.url
                return if (uri.scheme == "https" && uri.host == APP_HOST) {
                    false
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }
        }
        webView.webChromeClient = PrintPopupChromeClient()

        webView.loadUrl(APP_URL)

        if (FirebaseApp.getApps(this).isNotEmpty()) {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                serverSyncManager.registerPushToken(token)
            }
        }

        if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O..Build.VERSION_CODES.P) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestStoragePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    inner class SyncBridge {
        @JavascriptInterface
        fun configure(baseUrl: String, token: String): Boolean {
            val normalized = baseUrl.trim().trimEnd('/')
            if (!normalized.startsWith("https://")) return false
            appStateStore.configureSync(normalized, token.trim())
            serverSyncManager.syncNow()
            return true
        }

        @JavascriptInterface
        fun login(baseUrl: String, login: String, password: String): String = try {
            val result = serverSyncManager.login(baseUrl, login, password)
            if (FirebaseApp.getApps(this@MainActivity).isNotEmpty()) {
                FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                    serverSyncManager.registerPushToken(token)
                }
            }
            result
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Ошибка входа").toString()
        }

        @JavascriptInterface
        fun createUser(json: String): String = try {
            serverSyncManager.createUser(json)
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Ошибка создания пользователя").toString()
        }

        @JavascriptInterface
        fun listConflicts(): String = try {
            serverSyncManager.listConflicts()
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Ошибка загрузки конфликтов").toString()
        }

        @JavascriptInterface
        fun resolveConflict(id: Long, decision: String): String = try {
            serverSyncManager.resolveConflict(id, decision)
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Ошибка решения конфликта").toString()
        }

        @JavascriptInterface
        fun registerPushToken(token: String): Boolean = serverSyncManager.registerPushToken(token)

        @JavascriptInterface
        fun uploadImage(dataUrl: String): String = try {
            serverSyncManager.uploadImage(dataUrl)
        } catch (e: Exception) {
            JSONObject().put("error", e.message ?: "Ошибка загрузки фотографии").toString()
        }

        @JavascriptInterface
        fun status(): String = appStateStore.syncStatusJson()

        @JavascriptInterface
        fun syncNow() = serverSyncManager.syncNow()

        @JavascriptInterface
        fun disconnect() = appStateStore.clearSyncAuth()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(
                NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "События склада",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply { description = "Поступления на пост, заявки и согласование актов" }
            )
        }
    }

    inner class NotificationBridge {
        @JavascriptInterface
        fun notify(title: String, body: String) {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) return@runOnUiThread
                val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    android.app.Notification.Builder(this@MainActivity, NOTIFICATION_CHANNEL_ID)
                } else {
                    @Suppress("DEPRECATION")
                    android.app.Notification.Builder(this@MainActivity)
                }
                val notification = builder
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(title.take(80))
                    .setContentText(body.take(240))
                    .setStyle(android.app.Notification.BigTextStyle().bigText(body.take(1000)))
                    .setAutoCancel(true)
                    .build()
                (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                    .notify((System.currentTimeMillis() and 0x7fffffff).toInt(), notification)
            }
        }
    }

    /** Экранирует строку для безопасной подстановки в виде JS string-литерала. */
    private fun jsStringLiteral(s: String): String {
        val escaped = s.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\n", "\\n").replace("\r", "")
        return "'$escaped'"
    }

    /**
     * window.AndroidScanner.requestScan() из prototype.html (см. startNativeScan()).
     * Вызов JS-интерфейса приходит в фоновом потоке WebView, поэтому запуск
     * Activity явно переносится на UI-поток.
     */
    inner class ScannerBridge {
        @JavascriptInterface
        fun requestScan() {
            runOnUiThread {
                scanLauncher.launch(Intent(this@MainActivity, QrScanActivity::class.java))
            }
        }
    }

    /**
     * window.AndroidFiles.saveExportedFile(base64, filename, mimeType) из
     * prototype.html (см. xlsxDownload()). Раньше экспорт в Excel создавал
     * Blob + <a download> — в Android WebView это НЕ сохраняет файл на
     * устройство (нет DownloadListener/моста), но UI показывал "Файл скачан"
     * независимо от реального результата (#3 ревью). Теперь файл пишется
     * напрямую в публичную папку "Загрузки" через MediaStore (API 29+) или
     * через legacy File API (API 26-28), и JS получает настоящий Boolean.
     */
    inner class FileExportBridge {
        @JavascriptInterface
        fun saveExportedFile(base64: String, filename: String, mimeType: String): Boolean {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val resolver = contentResolver
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, filename)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: return false
                    var published = false
                    try {
                        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        published = resolver.update(uri, values, null, null) > 0
                        published
                    } finally {
                        // Не оставляем в Downloads невидимый/повреждённый файл,
                        // если поток не открылся, запись оборвалась или публикация
                        // IS_PENDING=0 не удалась.
                        if (!published) runCatching { resolver.delete(uri, null, null) }
                    }
                } else {
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        return false
                    }
                    @Suppress("DEPRECATION")
                    val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!downloadsDir.exists()) downloadsDir.mkdirs()
                    val file = File(downloadsDir, filename)
                    FileOutputStream(file).use { it.write(bytes) }
                    true
                }
            } catch (e: Exception) {
                Log.e("FileExportBridge", "saveExportedFile('$filename') failed", e)
                false
            }
        }
    }

    /**
     * window.AndroidPrint.printHtml(html, jobName) из prototype.html
     * (см. printHtmlDocument()/printLabel()/printDoc()). Раньше печать шла через
     * window.open()+document.write()+window.print() во втором WebView — обычный
     * Android WebView НЕ реализует window.print(), так что реальной системной
     * печати/сохранения в PDF не происходило (#4 ревью). Теперь HTML грузится в
     * офскрин WebView и печатается через настоящий PrintManager.
     */
    inner class PrintBridge {
        @JavascriptInterface
        fun printHtml(html: String, jobName: String, pageFormat: String) {
            runOnUiThread { printHtmlContent(html, jobName, pageFormat) }
        }
    }

    private fun printHtmlContent(html: String, jobName: String, pageFormat: String) {
        val printWebView = WebView(this)
        printWebView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                val printManager = getSystemService(PRINT_SERVICE) as PrintManager
                val adapter = view.createPrintDocumentAdapter(jobName)
                // CSS задаёт внутренние поля документа, поэтому нативные поля
                // всегда нулевые: иначе Android добавлял их второй раз. Для
                // этикетки задаём реальный носитель 60×40 мм (размеры в mils),
                // чтобы драйвер принтера не подменял его A4/Letter.
                val attributes = if (pageFormat == "label") {
                    PrintAttributes.Builder()
                        .setMediaSize(
                            PrintAttributes.MediaSize(
                                "TRESHKA_LABEL_60X40",
                                "ТРЁШКА 60×40 мм",
                                2362,
                                1575,
                            )
                        )
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build()
                } else {
                    PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build()
                }
                printManager.print(jobName, adapter, attributes)
            }
        }
        printWebView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    /**
     * window.AndroidPhoto.pickPhoto(itemId) из prototype.html (см. requestItemPhoto()).
     * Раньше карточка товара вообще не могла принять фото — не было ни поля в
     * модели данных, ни способа получить изображение из WebView (обычный
     * <input type=file> без onShowFileChooser в системном WebView молча
     * ничего не делает). Показывает выбор "Камера / Галерея", результат уходит
     * в JS асинхронно через window.onPhotoPicked(itemId, dataUrl, error) —
     * сам pickPhoto() ничего не возвращает, как и остальные мосты, работающие
     * через системные Activity (см. ScannerBridge выше).
     *
     * Камера использует MediaStore.ACTION_IMAGE_CAPTURE с превью-Bitmap из
     * extras "data" — сознательный компромисс: это уменьшенное превью (не
     * полноразмерный кадр через FileProvider/Uri), но для идентификации
     * позиции на складе этого достаточно, а лишний провайдер файлов/разрешения
     * на запись не нужны. Оба источника (камера/галерея) перед кодированием
     * в base64 ужимаются до 640px по большей стороне (см. scaleBitmap) —
     * иначе полноразмерные фото раздули бы JSON-состояние склада и SQLite.
     */
    inner class PhotoBridge {
        @JavascriptInterface
        fun pickPhoto(itemId: String) {
            runOnUiThread { showPhotoSourceDialog(itemId) }
        }
    }

    private fun showPhotoSourceDialog(itemId: String) {
        val options = arrayOf("📷 Камера", "🖼 Галерея")
        AlertDialog.Builder(this)
            .setTitle("Фото товара")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED
                        ) {
                            pendingPhotoItemId = itemId
                            cameraPhotoLauncher.launch(Intent(MediaStore.ACTION_IMAGE_CAPTURE))
                        } else {
                            pendingCameraPermissionItemId = itemId
                            requestCameraPermission.launch(Manifest.permission.CAMERA)
                        }
                    }
                    1 -> {
                        pendingPhotoItemId = itemId
                        galleryPhotoLauncher.launch("image/*")
                    }
                }
            }
            .setOnCancelListener { deliverPhotoError(itemId, "Отменено") }
            .show()
    }

    private fun deliverPhoto(itemId: String, bitmap: Bitmap) {
        try {
            val scaled = scaleBitmap(bitmap, 640)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 72, out)
            val base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            webView.evaluateJavascript(
                "window.onPhotoPicked && window.onPhotoPicked(${jsStringLiteral(itemId)}, " +
                    "${jsStringLiteral("data:image/jpeg;base64,$base64")}, null);",
                null
            )
        } catch (e: Exception) {
            Log.e("PhotoBridge", "encode failed for item $itemId", e)
            deliverPhotoError(itemId, "Не удалось обработать фото")
        }
    }

    private fun deliverPhotoError(itemId: String, message: String) {
        webView.evaluateJavascript(
            "window.onPhotoPicked && window.onPhotoPicked(${jsStringLiteral(itemId)}, null, ${jsStringLiteral(message)});",
            null
        )
    }

    // Степень уменьшения при декодировании (только степени двойки — так умеет
    // BitmapFactory без потери качества сэмплирования): считается по ИСХОДНЫМ
    // размерам изображения (из inJustDecodeBounds), не требуя загрузки пикселей.
    private fun calculateInSampleSize(width: Int, height: Int, reqSize: Int): Int {
        var inSampleSize = 1
        if (height > reqSize || width > reqSize) {
            val halfHeight = height / 2
            val halfWidth = width / 2
            while ((halfHeight / inSampleSize) >= reqSize && (halfWidth / inSampleSize) >= reqSize) {
                inSampleSize *= 2
            }
        }
        return inSampleSize
    }

    // Двухпроходное декодирование: первый проход (inJustDecodeBounds=true) не
    // выделяет память под пиксели — только читает ширину/высоту; второй проход
    // decodes сразу с нужным inSampleSize, а не в полном разрешении с
    // последующим Bitmap.createScaledBitmap() (см. deliverPhoto/scaleBitmap) —
    // так пиковое потребление памяти на большом фото из галереи многократно ниже.
    private fun decodeSampledBitmapFromUri(uri: Uri, reqSize: Int): Bitmap? {
        val boundsOptions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, boundsOptions) }
        if (boundsOptions.outWidth <= 0 || boundsOptions.outHeight <= 0) return null

        val decodeOptions = BitmapFactory.Options().apply {
            inSampleSize = calculateInSampleSize(boundsOptions.outWidth, boundsOptions.outHeight, reqSize)
        }
        return contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, decodeOptions) }
    }

    private fun scaleBitmap(src: Bitmap, maxDim: Int): Bitmap {
        val w = src.width
        val h = src.height
        val scale = maxDim.toFloat() / maxOf(w, h)
        if (scale >= 1f) return src
        return Bitmap.createScaledBitmap(src, (w * scale).toInt(), (h * scale).toInt(), true)
    }

    private fun flushWebAppState() {
        // #9 ревью: evaluateJavascript() асинхронный — Android не даёт способа
        // синхронно выполнить JS и дождаться завершения записи в SQLite до того,
        // как onPause()/onStop() вернут управление. Это снижает, но не исключает
        // риск потери самых последних изменений при мгновенном убийстве процесса
        // (основная защита — короткий период автосохранения в prototype.html).
        webView.evaluateJavascript("window.__flushSaveBeforePause && window.__flushSaveBeforePause();", null)
    }

    override fun onPause() {
        super.onPause()
        flushWebAppState()
    }

    override fun onResume() {
        super.onResume()
        if (::serverSyncManager.isInitialized) serverSyncManager.syncNow()
    }

    override fun onStop() {
        super.onStop()
        flushWebAppState()
    }

    @Suppress("MissingSuperCall")
    override fun onBackPressed() {
        // #8 ревью: раньше здесь проверялась только webView.canGoBack() — реальная
        // история навигации WebView, которая в этом SPA почти не продвигается
        // (переходы держит собственный JS-стек прототипа, см. render()/goBack()
        // в prototype.html), так что системная кнопка "Назад" почти всегда сразу
        // закрывала приложение. Теперь запрос идёт в JS: __handleNativeBack()
        // сама решает, обработала ли она переход (вернула true) или мы уже на
        // самом верхнем уровне и Activity можно закрывать (false).
        webView.evaluateJavascript(
            "(function(){ try { return (window.__handleNativeBack ? window.__handleNativeBack() : false) + ''; } catch(e) { return 'false'; } })();"
        ) { result ->
            val handled = result?.trim('"') == "true"
            if (!handled) {
                runOnUiThread {
                    if (webView.canGoBack()) webView.goBack() else finish()
                }
            }
        }
    }

    /**
     * Прототип открывает окно печати через window.open('', '_blank', ...) ТОЛЬКО
     * в браузерном предпросмотре вне Android-приложения (см. printHtmlDocument()
     * в prototype.html) — внутри приложения печать теперь всегда идёт через
     * window.AndroidPrint (см. PrintBridge выше). Обработчик оставлен как
     * защитная сетка на случай любого другого window.open() в прототипе.
     */
    private inner class PrintPopupChromeClient : WebChromeClient() {
        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message
        ): Boolean {
            val popupWebView = WebView(this@MainActivity)
            popupWebView.settings.javaScriptEnabled = true
            popupWebView.webViewClient = WebViewClient()

            val dialog = Dialog(this@MainActivity, android.R.style.Theme_Material_Light_NoActionBar_Fullscreen)
            dialog.setContentView(popupWebView, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            ))
            popupWebView.webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) {
                    dialog.dismiss()
                }
            }
            dialog.setOnDismissListener { popupWebView.destroy() }
            dialog.show()

            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = popupWebView
            resultMsg.sendToTarget()
            return true
        }
    }
}
