package ua.genichka.wayback

import android.content.Context
import android.location.Location
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs
import kotlin.math.max

/**
 * Запис сліду з телефона (пішки, в лісі, в машині без Android Auto).
 *
 * Раніше слід писала сама сторінка через navigator.geolocation. Але WebView
 * перестає отримувати GPS, щойно екран гасне чи телефон іде в кишеню, — і в
 * сліді лишались кілька точок, з'єднаних прямими через ліс. Тепер точки пише
 * Android у службі переднього плану: вона працює з вимкненим екраном. Сторінка
 * лише забирає готові точки (recPts) і малює їх.
 *
 * Точка: [lat, lon, t(ms), acc(м), alt(м або NaN)] — той самий формат, що й у app.js.
 */
object PhoneTrack {
    private lateinit var file: File
    private val pts = ArrayList<DoubleArray>()
    private var id: String? = null
    private var minStep = 5.0
    private var maxAcc = 60.0
    private var lastBearing = Float.NaN
    private var jumps = 0
    private var lastFlush = 0L

    @Volatile
    var isRecording = false
        private set

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        file = File(ctx.applicationContext.filesDir, "phone_track.json")
        // процес міг загинути посеред запису — точки не губимо, сторінка продовжить той самий трек
        try {
            if (file.exists()) {
                val o = JSONObject(file.readText())
                id = if (o.isNull("id")) null else o.optString("id").ifBlank { null }
                val a = o.getJSONArray("pts")
                for (i in 0 until a.length()) {
                    val p = a.getJSONArray(i)
                    pts.add(doubleArrayOf(p.getDouble(0), p.getDouble(1), p.getDouble(2), p.optDouble(3, 0.0),
                        if (p.isNull(4)) Double.NaN else p.getDouble(4)))
                }
            }
        } catch (e: Exception) { pts.clear(); id = null }
    }

    /** Почати або продовжити запис треку [trackId]. Повторний виклик лише міняє налаштування. */
    @Synchronized
    fun start(ctx: Context, trackId: String, step: Double, acc: Double): Boolean {
        init(ctx)
        if (trackId != id) { pts.clear(); id = trackId; jumps = 0; lastBearing = Float.NaN }
        minStep = step.coerceIn(2.0, 30.0)
        maxAcc = acc.coerceIn(15.0, 100.0)
        if (!isRecording) {
            if (!LocationHub.acquire(ctx, "phone")) return false
            isRecording = true
            TrackService.start(ctx)
            LocationHub.last?.let { if (System.currentTimeMillis() - it.time < 10_000) onLocation(it) }
        }
        flush()
        return true
    }

    @Synchronized
    fun stop(ctx: Context) {
        if (isRecording) {
            isRecording = false
            LocationHub.release("phone")
        }
        pts.clear(); id = null
        try { file.delete() } catch (e: Exception) { /* */ }
        TrackService.stop(ctx)
    }

    /** Точки, починаючи з [from], для треку [trackId]. Чужий трек — порожньо. */
    @Synchronized
    fun json(trackId: String, from: Int): String {
        val o = JSONObject().put("id", id ?: JSONObject.NULL).put("n", pts.size).put("rec", isRecording)
        val a = JSONArray()
        if (trackId == id) for (i in max(0, from) until pts.size) a.put(pt(pts[i]))
        return o.put("pts", a).toString()
    }

    @Synchronized
    fun onLocation(loc: Location) {
        if (!isRecording) return
        val acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 30.0
        if (acc > maxAcc) return
        val p = doubleArrayOf(
            Math.round(loc.latitude * 1e6) / 1e6,
            Math.round(loc.longitude * 1e6) / 1e6,
            loc.time.toDouble(),
            Math.round(acc).toDouble(),
            if (loc.hasAltitude()) Math.round(loc.altitude).toDouble() else Double.NaN,
        )
        val last = pts.lastOrNull()
        if (last != null) {
            val d = Geo.dist(last[0], last[1], p[0], p[1])
            val dt = (p[2] - last[2]) / 1000
            if (dt <= 0) return
            val fast = loc.hasSpeed() && loc.speed > 6f            // понад ~22 км/год — їдемо
            val step = if (fast) max(10.0, acc * 0.4) else max(minStep, acc * 0.4)
            // поворот: курс GPS у русі змінився на 20°+ — точку пишемо раніше, щоб не зрізати кут
            val bearing = if (loc.hasBearing() && loc.hasSpeed() && loc.speed > 1f) loc.bearing else Float.NaN
            val turn = !bearing.isNaN() && !lastBearing.isNaN() && angDiff(bearing, lastBearing) >= 20f && d >= 2.0
            if (d < step && !turn) return
            // стрибок GPS — неможлива швидкість (понад ~200 км/год)
            if (d / dt > 55 && ++jumps < 3) return
            jumps = 0
            if (!bearing.isNaN()) lastBearing = bearing
        }
        pts.add(p)
        val now = SystemClock.elapsedRealtime()
        if (now - lastFlush > 10_000) flush()
    }

    private fun angDiff(a: Float, b: Float): Float {
        val d = abs(a - b) % 360f
        return if (d > 180f) 360f - d else d
    }

    private fun pt(p: DoubleArray): JSONArray = JSONArray().put(p[0]).put(p[1]).put(p[2].toLong()).put(p[3].toLong())
        .put(if (p[4].isNaN()) JSONObject.NULL else p[4].toLong())

    private fun flush() {
        lastFlush = SystemClock.elapsedRealtime()
        try {
            val a = JSONArray()
            for (p in pts) a.put(pt(p))
            val tmp = File(file.parentFile, "phone_track.tmp")
            tmp.writeText(JSONObject().put("id", id ?: JSONObject.NULL).put("pts", a).toString())
            if (!tmp.renameTo(file)) tmp.delete()
        } catch (e: Exception) { /* */ }
    }
}
