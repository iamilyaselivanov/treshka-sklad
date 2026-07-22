package com.treshka.sklad

import android.Manifest
import android.annotation.SuppressLint
import android.app.Dialog
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
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
import java.io.File
import java.io.FileOutputStream

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
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var appStateStore: AppStateStore

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

    // Разрешение на запись во внешнее хранилище нужно только на API 26-28
    // (Android 8-9): начиная с API 29 (Q) запись в коллекцию MediaStore.Downloads
    // не требует WRITE_EXTERNAL_STORAGE. Запрашиваем один раз при старте, чтобы
    // экспорт в Excel не падал молча на старых устройствах.
    private val requestStoragePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* результат неважен: saveExportedFile() сам проверит и вернёт false при отказе */ }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        appStateStore = AppStateStore(this)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(true)
            allowFileAccess = true
        }

        webView.addJavascriptInterface(WebAppInterface(appStateStore), "AndroidStorage")
        webView.addJavascriptInterface(ScannerBridge(), "AndroidScanner")
        webView.addJavascriptInterface(FileExportBridge(), "AndroidFiles")
        webView.addJavascriptInterface(PrintBridge(), "AndroidPrint")

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = PrintPopupChromeClient()

        webView.loadUrl("file:///android_asset/prototype.html")

        if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O..Build.VERSION_CODES.P) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestStoragePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
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
                    resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    true
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
        fun printHtml(html: String, jobName: String) {
            runOnUiThread { printHtmlContent(html, jobName) }
        }
    }

    private fun printHtmlContent(html: String, jobName: String) {
        val printWebView = WebView(this)
        printWebView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                val printManager = getSystemService(PRINT_SERVICE) as PrintManager
                val adapter = view.createPrintDocumentAdapter(jobName)
                val attributes = PrintAttributes.Builder().build()
                printManager.print(jobName, adapter, attributes)
            }
        }
        printWebView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
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

    override fun onStop() {
        super.onStop()
        flushWebAppState()
    }

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
