package ua.genichka.wayback

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Спільне сховище плиток на диску телефона.
 * Сюди пише і веб-частина (через перехоплення запитів у WebView), і екран машини.
 * Тому район, завантажений у меню «Карта», видно і на телефоні, і в Android Auto.
 */
object TileStore {
    private const val UA = "WayBack-Android/1.0 (+https://github.com/Genichka/WayBack)"
    private lateinit var root: File

    fun init(ctx: Context) {
        if (!::root.isInitialized) root = File(ctx.applicationContext.filesDir, "tiles")
    }

    private val UNSAFE = Regex("[^A-Za-z0-9._/-]")

    private fun fileFor(url: String): File {
        val key = Layers.tileKey(url).removePrefix("https://").replace(UNSAFE, "_")
        return File(root, key)
    }

    /** Плитка з диска або null. */
    fun bytes(url: String): ByteArray? {
        val f = fileFor(url)
        if (!f.isFile || f.length() == 0L) return null
        return try { f.readBytes() } catch (e: Exception) { null }
    }

    /** Завантажити з мережі й зберегти. null — немає звʼязку або сервер відмовив. */
    fun download(url: String): ByteArray? {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 9000
            conn.setRequestProperty("User-Agent", UA)
            if (conn.responseCode != 200) return null
            val data = conn.inputStream.use { it.readBytes() }
            if (data.isEmpty()) return null
            save(url, data)
            data
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun save(url: String, data: ByteArray) {
        try {
            val f = fileFor(url)
            val dir = f.parentFile ?: return
            dir.mkdirs()
            val tmp = File(dir, f.name + ".part" + Thread.currentThread().id)
            tmp.writeBytes(data)
            if (!tmp.renameTo(f)) tmp.delete()
        } catch (e: Exception) { /* місця немає — просто не кешуємо */ }
    }

    fun mime(data: ByteArray): String =
        if (data.size > 3 && data[0] == 0x89.toByte() && data[1] == 'P'.code.toByte()) "image/png" else "image/jpeg"

    fun sizeBytes(): Long =
        if (!root.exists()) 0L else root.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    fun clear() {
        root.deleteRecursively()
    }
}
