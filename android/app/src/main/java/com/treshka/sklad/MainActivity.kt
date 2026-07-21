package com.treshka.sklad

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Intent
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * ТРЁШКА склад — нативная Android-обёртка над однофайловым HTML/JS прототипом
 * (public/prototype.html), загружаемым из assets. Вся бизнес-логика
 * (склад, посты, документы, выдачи, роли, инвентаризация, QR) реализована
 * в самом прототипе; эта Activity — полноэкранный WebView плюс два нативных
 * моста в JS:
 *  - window.AndroidStorage — сохранение/загрузка всего состояния склада в SQLite
 *    (см. AppStateStore.kt/WebAppInterface.kt) — решает P0 "данные не должны
 *    теряться при обновлении приложения";
 *  - window.AndroidScanner — реальное сканирование QR камерой устройства через
 *    CameraX + ML Kit (см. QrScanActivity.kt) вместо демо-заглушки.
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
            webView.evaluateJavascript(
                "window.onNativeScanError && window.onNativeScanError('Сканирование отменено');",
                null
            )
        }
    }

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

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = PrintPopupChromeClient()

        webView.loadUrl("file:///android_asset/prototype.html")
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

    override fun onPause() {
        super.onPause()
        // Гарантированно сбрасываем несохранённые изменения перед уходом в фон —
        // на случай, если система убьёт процесс сразу после сворачивания приложения.
        webView.evaluateJavascript("window.__flushSaveBeforePause && window.__flushSaveBeforePause();", null)
    }

    override fun onBackPressed() {
        // Прототип ведёт свою собственную историю экранов через JS (кнопка
        // "назад" в шапке). Системную кнопку "назад" сворачиваем в закрытие
        // приложения, если WebView не может вернуться по реальной истории.
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    /**
     * Прототип открывает окно печати через window.open('', '_blank', ...)
     * и заполняет его через document.write(...) (см. printDoc()/printLabel()
     * в prototype.html). Обычный WebView такие window.open() без обработки
     * onCreateWindow просто игнорирует. Показываем содержимое всплывающего
     * окна во втором WebView внутри диалога поверх основного экрана.
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
