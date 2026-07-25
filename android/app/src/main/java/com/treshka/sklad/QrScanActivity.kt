package com.treshka.sklad

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.Size
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Реальное сканирование QR-кода камерой устройства (пункт #8 ревью — раньше
 * "сканирование" было демо-заглушкой, всегда открывающей один и тот же товар).
 *
 * Используется CameraX (Preview + ImageAnalysis) и ML Kit Barcode Scanning
 * (полностью офлайн, без обращения к сети). При первом успешно распознанном
 * QR-коде активность возвращает результат через Activity Result API — камера
 * не остаётся включённой без необходимости.
 *
 * Формат содержимого QR: "SKLAD-ITEM:<id>" — см. qrValue()/genQR() в
 * prototype.html (кодируется неизменяемый id карточки, не артикул).
 */
class QrScanActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_RESULT_VALUE = "result_value"
        // #12 ревью: раньше отказ в разрешении на камеру и сбой её запуска
        // одинаково превращались в "Сканирование отменено" — пользователь не мог
        // отличить "я сам отменил" от "камера не работает"/"нет разрешения".
        // Причина отмены передаётся обратно вызывающей Activity через этот extra.
        const val EXTRA_CANCEL_REASON = "cancel_reason"
        const val REASON_USER_CANCELLED = "user_cancelled"
        const val REASON_PERMISSION_DENIED = "permission_denied"
        const val REASON_CAMERA_ERROR = "camera_error"
    }

    private lateinit var cameraExecutor: ExecutorService
    private val resultDelivered = AtomicBoolean(false)
    private var barcodeScanner: com.google.mlkit.vision.barcode.BarcodeScanner? = null

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else finishWithCancel(REASON_PERMISSION_DENIED)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cameraExecutor = Executors.newSingleThreadExecutor()

        val previewView = PreviewView(this)
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(previewView, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            ))
        }

        val hint = TextView(this).apply {
            text = "Наведите камеру на QR-код карточки склада"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#88000000"))
            setPadding(24, 16, 24, 16)
            textSize = 15f
        }
        root.addView(hint, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; topMargin = 64 })

        val closeBtn = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finishWithCancel(REASON_USER_CANCELLED) }
        }
        root.addView(closeBtn, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { gravity = Gravity.TOP or Gravity.END; topMargin = 32; rightMargin = 24 })

        setContentView(root)
        this.previewView = previewView

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private lateinit var previewView: PreviewView

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = androidx.camera.core.Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            val scanner = BarcodeScanning.getClient()
            barcodeScanner = scanner
            val analysis = ImageAnalysis.Builder()
                .setTargetResolution(Size(1280, 720))
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                processFrame(imageProxy, scanner)
            }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis
                )
            } catch (e: Exception) {
                finishWithCancel(REASON_CAMERA_ERROR)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(markerClass = [androidx.camera.core.ExperimentalGetImage::class])
    private fun processFrame(imageProxy: ImageProxy, scanner: com.google.mlkit.vision.barcode.BarcodeScanner) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) { imageProxy.close(); return }
        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                if (!resultDelivered.get()) {
                    val hit = barcodes.firstOrNull { it.valueType == Barcode.TYPE_TEXT || it.rawValue != null }
                    val value = hit?.rawValue
                    if (!value.isNullOrBlank()) {
                        finishWithResult(value)
                    }
                }
            }
            .addOnFailureListener {
                // Игнорируем единичный сбой распознавания кадра — попробуем на следующем кадре.
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    private fun finishWithResult(value: String) {
        if (!resultDelivered.compareAndSet(false, true)) return
        val data = Intent().putExtra(EXTRA_RESULT_VALUE, value)
        setResult(RESULT_OK, data)
        finish()
    }

    private fun finishWithCancel(reason: String) {
        if (!resultDelivered.compareAndSet(false, true)) return
        val data = Intent().putExtra(EXTRA_CANCEL_REASON, reason)
        setResult(RESULT_CANCELED, data)
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        // #12 ревью: ML Kit BarcodeScanner держит нативные ресурсы и должен быть
        // явно закрыт — раньше он не закрывался вовсе.
        barcodeScanner?.close()
        barcodeScanner = null
    }
}
