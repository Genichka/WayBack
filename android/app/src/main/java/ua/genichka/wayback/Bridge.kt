package ua.genichka.wayback

import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import android.view.WindowManager
import android.webkit.JavascriptInterface

/** Обʼєкт window.WayBackNative у веб-частині. Викликається не з UI-потоку. */
class Bridge(private val act: MainActivity) {

    /** Веб повідомляє, що змінилось: точки, ціль, шар, поточний трек. */
    @JavascriptInterface
    fun sync(json: String) = WebState.update(json)

    /** Треки з машини й паркування, які веб ще не забрав. */
    @JavascriptInterface
    fun pending(): String = TripStore.pendingJson()

    @JavascriptInterface
    fun ack(json: String) = TripStore.ack(json)

    @JavascriptInterface
    fun tileBytes(): String = TileStore.sizeBytes().toString()

    @JavascriptInterface
    fun clearTiles() = TileStore.clear()

    @JavascriptInterface
    fun carRecording(): Boolean = TripStore.isRecording

    @JavascriptInterface
    fun keepScreen(on: Boolean) {
        act.runOnUiThread {
            if (on) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    /** Експорт GPX/JSON у «Завантаження/WayBack». */
    @JavascriptInterface
    fun saveFile(name: String, text: String, mime: String): Boolean = try {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/WayBack")
        }
        val r = act.contentResolver
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) false
        else {
            r.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            true
        }
    } catch (e: Exception) {
        false
    }

    @JavascriptInterface
    fun share(title: String, text: String) {
        act.runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            try { act.startActivity(Intent.createChooser(send, title)) } catch (e: Exception) { /* */ }
        }
    }

    @JavascriptInterface
    fun appVersion(): String = try {
        act.packageManager.getPackageInfo(act.packageName, 0).versionName ?: ""
    } catch (e: Exception) { "" }
}
