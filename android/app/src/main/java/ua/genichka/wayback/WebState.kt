package ua.genichka.wayback

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Що веб-частина показує на телефоні: точки, ціль, шар карти і поточний трек.
 * Веб надсилає це через WayBackNative.sync(), екран машини малює звідси.
 * Зберігається, тож у машині точки видно, навіть якщо телефонний екран сьогодні не відкривали.
 */
object WebState {
    class Pt(val id: String, val name: String, val icon: String, val lat: Double, val lon: Double)

    @Volatile var points: List<Pt> = emptyList(); private set
    @Volatile var targetId: String? = null; private set
    @Volatile var layer: String = "topo"; private set
    @Volatile var track: List<DoubleArray> = emptyList(); private set

    private lateinit var prefs: SharedPreferences
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    @Synchronized
    fun init(ctx: Context) {
        if (::prefs.isInitialized) return
        prefs = ctx.applicationContext.getSharedPreferences("wb", Context.MODE_PRIVATE)
        prefs.getString("web", null)?.let { parse(it) }
    }

    fun update(json: String) {
        if (!parse(json)) return
        prefs.edit().putString("web", json).apply()
        for (l in listeners) l()
    }

    val target: Pt? get() = targetId?.let { id -> points.firstOrNull { it.id == id } }

    private fun parse(json: String): Boolean = try {
        val o = JSONObject(json)
        val pa = o.optJSONArray("points")
        val pts = ArrayList<Pt>()
        if (pa != null) for (i in 0 until pa.length()) {
            val p = pa.getJSONObject(i)
            pts.add(Pt(p.optString("id"), p.optString("name"), p.optString("icon", "📍"),
                p.getDouble("lat"), p.getDouble("lon")))
        }
        val ta = o.optJSONArray("track")
        val tr = ArrayList<DoubleArray>()
        if (ta != null) for (i in 0 until ta.length()) {
            val p = ta.getJSONArray(i)
            tr.add(doubleArrayOf(p.getDouble(0), p.getDouble(1)))
        }
        points = pts
        targetId = if (o.isNull("target")) null else o.optString("target")
        layer = o.optString("layer", "topo")
        track = tr
        true
    } catch (e: Exception) {
        false
    }
}
