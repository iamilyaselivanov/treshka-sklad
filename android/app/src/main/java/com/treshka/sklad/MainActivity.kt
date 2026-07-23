package com.treshka.sklad

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

private const val APP_URL = "https://sklad-ok-prototype.janfoody2016.chatgpt.site/"
private const val APP_HOST = "sklad-ok-prototype.janfoody2016.chatgpt.site"

/**
 * Android-клиент версии 1.6. Интерфейс, авторизация и складские данные
 * загружаются с единого сервера, поэтому сайт и APK всегда используют одну базу.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(5, 7, 10))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                allowFileAccess = false
                allowContentAccess = false
                setSupportMultipleWindows(false)
            }
        }
        setContentView(webView)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return if (uri.scheme == "https" && uri.host == APP_HOST) {
                    false
                } else {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) showConnectionError()
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(APP_URL) else webView.restoreState(savedInstanceState)
    }

    private fun showConnectionError() {
        val html = """
            <!doctype html><html lang="ru"><meta name="viewport" content="width=device-width">
            <body style="margin:0;background:#05070a;color:#e8ebf0;font-family:sans-serif;display:grid;
              place-items:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box">
              <main><h2>Нет связи с сервером</h2><p style="color:#8a92a3">Проверьте интернет и повторите.</p>
              <button onclick="location.href='$APP_URL'" style="border:0;border-radius:12px;padding:14px 22px;
                background:#4f8cff;color:white;font-weight:700">Повторить</button></main>
            </body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(APP_URL, html, "text/html", "UTF-8", null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
