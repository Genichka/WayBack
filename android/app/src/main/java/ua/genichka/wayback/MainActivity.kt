package ua.genichka.wayback

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

/**
 * Телефонна частина: той самий WayBack, що й на GitHub Pages, тільки файли лежать у APK.
 * Плитки карти перехоплюються і йдуть через спільне сховище TileStore — їх бачить і машина.
 */
class MainActivity : Activity() {

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$HOST/assets/www/index.html"
        private const val REQ_LOC = 1
        private const val REQ_CAM = 2
        private const val REQ_FILE = 3

        @Volatile private var instance: MainActivity? = null

        /** Машина щось записала (трек, паркування) — хай веб забере одразу, якщо відкритий. */
        fun notifyWeb() {
            val a = instance ?: return
            a.runOnUiThread { a.pullFromNative() }
        }
    }

    private lateinit var web: WebView
    private lateinit var assets: WebViewAssetLoader
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private var geoPending: Pair<String, GeolocationPermissions.Callback>? = null
    private var camPending: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        App.init(this)
        instance = this

        assets = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString WayBackApp"
        }
        web.addJavascriptInterface(Bridge(this), "WayBackNative")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()

        askPermissions()
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(START_URL)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        pullFromNative()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // спершу закрити відкриту панель у веб-частині; якщо нічого — згорнути, а не вбити
        web.evaluateJavascript("(window.wbBack && window.wbBack()) || false") { r ->
            if (r != "true") moveTaskToBack(true)
        }
    }

    fun pullFromNative() {
        if (::web.isInitialized) web.evaluateJavascript("window.wbNativePull && window.wbNativePull()", null)
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun askPermissions() {
        val want = mutableListOf<String>()
        if (!LocationHub.hasPermission(this)) {
            want += Manifest.permission.ACCESS_FINE_LOCATION
            want += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            want += Manifest.permission.POST_NOTIFICATIONS
        }
        if (want.isNotEmpty()) requestPermissions(want.toTypedArray(), REQ_LOC)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        when (code) {
            REQ_LOC -> geoPending?.let { (origin, cb) ->
                cb.invoke(origin, LocationHub.hasPermission(this), false)
                geoPending = null
            }
            REQ_CAM -> camPending?.let { req ->
                if (granted(Manifest.permission.CAMERA)) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                else req.deny()
                camPending = null
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCb = null
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            val i = if (uri.scheme == "intent") Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME)
            else Intent(Intent.ACTION_VIEW, uri)
            startActivity(i)
        } catch (e: ActivityNotFoundException) {
            /* немає програми для цього посилання */
        } catch (e: Exception) { /* */ }
    }

    private fun tileResponse(url: String): WebResourceResponse {
        val hit = TileStore.bytes(url)
        val data = hit ?: TileStore.download(url)
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Expose-Headers" to "X-WB-Cache",
            "X-WB-Cache" to if (hit != null) "hit" else "miss",
        )
        return if (data != null) {
            WebResourceResponse(TileStore.mime(data), null, 200, "OK", headers, ByteArrayInputStream(data))
        } else {
            WebResourceResponse("text/plain", "utf-8", 504, "Offline", headers, ByteArrayInputStream(ByteArray(0)))
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val u = request.url
            if (u.host == HOST) return assets.shouldInterceptRequest(u)
            if (request.method == "GET" && u.scheme == "https" && Layers.isTileHost(u.host)) {
                return tileResponse(u.toString())
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == HOST) return false
            openExternal(request.url)
            return true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            pullFromNative()
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            if (LocationHub.hasPermission(this@MainActivity)) {
                callback.invoke(origin, true, false)
            } else {
                geoPending = origin to callback
                requestPermissions(
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                    REQ_LOC,
                )
            }
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources) {
                    request.deny()
                } else if (granted(Manifest.permission.CAMERA)) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    camPending = request
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAM)
                }
            }
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: WebChromeClient.FileChooserParams,
        ): Boolean {
            fileCb?.onReceiveValue(null)
            fileCb = callback
            val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            return try {
                startActivityForResult(Intent.createChooser(pick, "Вибери файл"), REQ_FILE)
                true
            } catch (e: Exception) {
                fileCb = null
                false
            }
        }
    }
}
