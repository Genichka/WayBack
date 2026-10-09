package ua.genichka.wayback

import android.content.Context
import android.content.SharedPreferences
import android.location.Location
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.max

/**
 * Треки, записані в машині, і місце паркування.
 * Кожен трек — окремий файл trips/<start>.json. Завершені треки й паркування
 * чекають, поки їх забере веб-частина (історія треків і точка 🚗 на телефоні).
 */
object TripStore {
    class Trip(val start: Long, var end: Long?, val pts: MutableList<DoubleArray>, var dist: Double)

    private lateinit var dir: File
    private lateinit var prefs: SharedPreferences
    private var lastFlush = 0L
    private var jumps = 0

    var current: Trip? = null
        private set

    val isRecording get() = current != null

    @Synchronized
    fun init(ctx: Context) {
        if (::dir.isInitialized) return
        dir = File(ctx.applicationContext.filesDir, "trips").apply { mkdirs() }
        prefs = ctx.applicationContext.getSharedPreferences("wb", Context.MODE_PRIVATE)
        // Процес міг загинути посеред поїздки — такий трек закриваємо, щоб не пропав.
        dir.listFiles()?.forEach { f ->
            val t = read(f) ?: return@forEach
            if (t.end == null) {
                if (t.pts.size > 1) { t.end = t.pts.last()[2].toLong(); write(t) } else f.delete()
            }
        }
    }

    @Synchronized
    fun start() {
        if (current != null) return
        current = Trip(System.currentTimeMillis(), null, mutableListOf(), 0.0)
        jumps = 0
        LocationHub.last?.let { onLocation(it) }
    }

    /** Завершити запис. true — трек збережено (у ньому хоч дві точки). */
    @Synchronized
    fun stop(): Boolean {
        val t = current ?: return false
        current = null
        t.end = System.currentTimeMillis()
        val f = fileOf(t.start)
        return if (t.pts.size > 1) { write(t); true } else { f.delete(); false }
    }

    @Synchronized
    fun onLocation(loc: Location) {
        val t = current ?: return
        if (loc.hasAccuracy() && loc.accuracy > 50f) return
        val acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0
        val p = doubleArrayOf(
            Math.round(loc.latitude * 1e6) / 1e6,
            Math.round(loc.longitude * 1e6) / 1e6,
            loc.time.toDouble(),
            Math.round(acc).toDouble(),
            if (loc.hasAltitude()) Math.round(loc.altitude).toDouble() else Double.NaN,
        )
        val last = t.pts.lastOrNull()
        if (last != null) {
            val d = Geo.dist(last[0], last[1], p[0], p[1])
            if (d < max(15.0, acc * 0.4)) return
            val dt = (p[2] - last[2]) / 1000
            // стрибок GPS — неможлива швидкість (понад ~200 км/год)
            if (dt > 0 && d / dt > 55 && ++jumps < 3) return
            jumps = 0
            t.dist += d
        }
        t.pts.add(p)
        val now = SystemClock.elapsedRealtime()
        if (now - lastFlush > 15_000) { lastFlush = now; write(t) }
    }

    @Synchronized
    fun setParking(lat: Double, lon: Double) {
        val o = JSONObject().put("lat", lat).put("lon", lon).put("t", System.currentTimeMillis())
        prefs.edit().putString("parking", o.toString()).apply()
    }

    /** Що веб-частина ще не забрала: завершені треки і паркування. */
    @Synchronized
    fun pendingJson(): String {
        val trips = JSONArray()
        dir.listFiles()?.sortedBy { it.name }?.forEach { f ->
            val t = read(f) ?: return@forEach
            if (t.end != null && t.start != current?.start) trips.put(toJson(t))
        }
        val o = JSONObject().put("trips", trips)
        prefs.getString("parking", null)?.let { o.put("parking", JSONObject(it)) }
        return o.toString()
    }

    /** Веб підтвердив, що забрав — прибираємо. */
    @Synchronized
    fun ack(json: String) {
        try {
            val o = JSONObject(json)
            o.optJSONArray("trips")?.let { a ->
                for (i in 0 until a.length()) {
                    val start = a.optLong(i, -1L)
                    if (start > 0 && start != current?.start) fileOf(start).delete()
                }
            }
            val pt = o.optLong("parking", -1L)
            if (pt > 0) {
                val cur = prefs.getString("parking", null)?.let { JSONObject(it).optLong("t") }
                if (cur == pt) prefs.edit().remove("parking").apply()
            }
        } catch (e: Exception) { /* зіпсований json — нічого не чіпаємо */ }
    }

    private fun fileOf(start: Long) = File(dir, "$start.json")

    private fun toJson(t: Trip): JSONObject {
        val pts = JSONArray()
        for (p in t.pts) {
            pts.put(JSONArray().put(p[0]).put(p[1]).put(p[2].toLong()).put(p[3].toLong())
                .put(if (p[4].isNaN()) JSONObject.NULL else p[4].toLong()))
        }
        return JSONObject().put("start", t.start).put("end", t.end ?: JSONObject.NULL)
            .put("dist", t.dist).put("pts", pts)
    }

    private fun write(t: Trip) {
        try {
            val f = fileOf(t.start)
            val tmp = File(dir, "${t.start}.tmp")
            tmp.writeText(toJson(t).toString())
            if (!tmp.renameTo(f)) tmp.delete()
        } catch (e: Exception) { /* */ }
    }

    private fun read(f: File): Trip? {
        if (!f.name.endsWith(".json")) return null
        return try {
            val o = JSONObject(f.readText())
            val a = o.getJSONArray("pts")
            val pts = MutableList(a.length()) { i ->
                val p = a.getJSONArray(i)
                doubleArrayOf(p.getDouble(0), p.getDouble(1), p.getDouble(2), p.optDouble(3, 0.0),
                    if (p.isNull(4)) Double.NaN else p.getDouble(4))
            }
            Trip(o.getLong("start"), if (o.isNull("end")) null else o.getLong("end"), pts, o.optDouble("dist", 0.0))
        } catch (e: Exception) {
            null
        }
    }
}
