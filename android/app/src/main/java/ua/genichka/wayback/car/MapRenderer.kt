package ua.genichka.wayback.car

import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.location.Location
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import android.view.Surface
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import ua.genichka.wayback.Layers
import ua.genichka.wayback.TileStore
import ua.genichka.wayback.TripStore
import ua.genichka.wayback.WebState
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sinh
import kotlin.math.tan

/**
 * Малює карту на екрані машини: плитки зі спільного сховища (офлайн), а якщо їх немає
 * і є інтернет — догружає й зберігає. Поверх — трек поїздки, трек з телефона, точки і «я».
 * Карта північчю догори. Поки «стежу», центр карти — моя позиція.
 */
class MapRenderer(private val ctx: CarContext, private val prefs: SharedPreferences) : SurfaceCallback {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newFixedThreadPool(3)
    private val mem = object : LruCache<String, Bitmap>(
        (Runtime.getRuntime().maxMemory() / 1024 / 6).toInt()
    ) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }
    private val loading: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val failed = ConcurrentHashMap<String, Long>()
    @Volatile private var netPauseUntil = 0L

    private var surface: Surface? = null
    private var width = 0
    private var height = 0
    private var density = 1.5f
    private var visible: Rect? = null

    private var follow = true
    private var zoom = prefs.getFloat("carZoom", 15f)
    private var cLat = prefs.getFloat("carLat", 49.0f).toDouble()
    private var cLon = prefs.getFloat("carLon", 31.3f).toDouble()
    private var me: Location? = null
    private var drawQueued = false
    private var disposed = false

    var layerKey: String = prefs.getString("carLayer", null) ?: WebState.layer
        set(v) {
            field = v
            prefs.edit().putString("carLayer", v).apply()
            requestDraw()
        }

    fun post(r: Runnable) { main.post(r) }

    fun requestDraw() {
        if (drawQueued || disposed) return
        drawQueued = true
        main.postDelayed({ drawQueued = false; draw() }, 30)
    }

    fun onLocation(loc: Location) {
        me = loc
        if (follow) { cLat = loc.latitude; cLon = loc.longitude }
        requestDraw()
    }

    fun recenter() {
        follow = true
        me?.let { cLat = it.latitude; cLon = it.longitude }
        requestDraw()
    }

    fun zoomBy(d: Int) {
        zoom = (zoom.roundToInt() + d).coerceIn(MIN_Z, MAX_Z).toFloat()
        requestDraw()
    }

    fun dispose() {
        disposed = true
        prefs.edit().putFloat("carZoom", zoom).putFloat("carLat", cLat.toFloat())
            .putFloat("carLon", cLon.toFloat()).apply()
        io.shutdownNow()
        mem.evictAll()
    }

    /* ---------- SurfaceCallback ---------- */

    override fun onSurfaceAvailable(c: SurfaceContainer) {
        surface = c.surface
        width = c.width
        height = c.height
        density = (c.dpi / 160f).coerceIn(1f, 3f)
        requestDraw()
    }

    override fun onSurfaceDestroyed(c: SurfaceContainer) {
        surface = null
    }

    override fun onVisibleAreaChanged(r: Rect) { visible = r; requestDraw() }
    override fun onStableAreaChanged(r: Rect) { requestDraw() }

    /** Перетягування в режимі «рука» (кнопка PAN). */
    override fun onScroll(distanceX: Float, distanceY: Float) {
        follow = false
        val ws = worldPx(zoom)
        val x = lonToX(cLon) * ws + distanceX
        val y = latToY(cLat) * ws + distanceY
        cLon = xToLon(x / ws)
        cLat = yToLat((y / ws).coerceIn(0.0, 1.0))
        requestDraw()
    }

    override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) {
        if (scaleFactor <= 0f) return
        zoom = (zoom + (ln(scaleFactor.toDouble()) / ln(2.0)).toFloat()).coerceIn(MIN_Z.toFloat(), MAX_Z.toFloat())
        requestDraw()
    }

    /* ---------- проєкція (Web Mercator, 0..1) ---------- */

    private fun lonToX(lon: Double) = (lon + 180.0) / 360.0
    private fun latToY(lat: Double): Double {
        val r = Math.toRadians(lat.coerceIn(-85.05, 85.05))
        return (1.0 - ln(tan(r) + 1.0 / cos(r)) / PI) / 2.0
    }
    private fun xToLon(x: Double) = x * 360.0 - 180.0
    private fun yToLat(y: Double) = Math.toDegrees(atan(sinh(PI * (1.0 - 2.0 * y))))

    /** Розмір світу в пікселях екрана на масштабі z. */
    private fun worldPx(z: Float): Double = 256.0 * density * 2.0.pow(z.toDouble())

    /* ---------- малювання ---------- */

    private fun draw() {
        val s = surface ?: return
        if (!s.isValid || width == 0) return
        val canvas = try { s.lockHardwareCanvas() } catch (e: Exception) { return }
        try {
            render(canvas)
        } finally {
            try { s.unlockCanvasAndPost(canvas) } catch (e: Exception) { /* */ }
        }
    }

    private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }

    private fun render(c: Canvas) {
        c.drawColor(Color.rgb(0x11, 0x12, 0x17))
        val area = visible?.takeIf { it.width() > 0 && it.height() > 0 } ?: Rect(0, 0, width, height)
        val ax = area.exactCenterX().toDouble()
        val ay = area.exactCenterY().toDouble()
        val ws = worldPx(zoom)
        val cx = lonToX(cLon) * ws
        val cy = latToY(cLat) * ws
        // перетворення координат у пікселі екрана
        fun sx(lon: Double) = (lonToX(lon) * ws - cx + ax).toFloat()
        fun sy(lat: Double) = (latToY(lat) * ws - cy + ay).toFloat()

        drawTiles(c, ws, cx - ax, cy - ay)

        // трек, що пишеться на телефоні (пішки) — фіолетовий пунктир як в історії
        WebState.track.takeIf { it.size > 1 }?.let { tr ->
            drawLine(c, tr.size, { sx(tr[it][1]) }, { sy(tr[it][0]) }, Color.rgb(0xb3, 0x88, 0xff), 3f)
        }
        // трек поїздки — жовтий з темною обводкою, як трек у вебі
        TripStore.current?.pts?.takeIf { it.size > 1 }?.let { tr ->
            drawLine(c, tr.size, { sx(tr[it][1]) }, { sy(tr[it][0]) }, Color.rgb(0xff, 0xb3, 0x00), 4f)
        }
        // точки з телефона
        val tgt = WebState.targetId
        for (p in WebState.points) {
            val x = sx(p.lon); val y = sy(p.lat)
            if (x < -50 || y < -50 || x > width + 50 || y > height + 50) continue
            drawPin(c, x, y, p.icon, p.name, p.id == tgt)
        }
        me?.let { drawMe(c, sx(it.longitude), sy(it.latitude), it) }

        // підпис джерела карти — вимога ліцензій OSM/Esri
        text.textAlign = Paint.Align.LEFT
        text.textSize = 10f * density
        text.color = Color.argb(200, 255, 255, 255)
        text.setShadowLayer(2f, 0f, 0f, Color.BLACK)
        c.drawText(Layers.get(layerKey).attr, area.left + 8f * density, area.bottom - 6f * density, text)
        text.clearShadowLayer()
        text.textAlign = Paint.Align.CENTER
    }

    private fun drawTiles(c: Canvas, ws: Double, ox: Double, oy: Double) {
        val l = Layers.get(layerKey)
        val zi = floor(zoom).toInt().coerceIn(MIN_Z, MAX_Z)
        val tz = min(zi, l.maxZoom)                 // далі за maxZoom — розтягуємо плитки
        val n = 1 shl tz
        val tile = ws / n                           // розмір плитки на екрані, px
        val x0 = floor(ox / tile).toInt()
        val y0 = max(0, floor(oy / tile).toInt())
        val x1 = floor((ox + width) / tile).toInt()
        val y1 = min(n - 1, floor((oy + height) / tile).toInt())
        val dst = RectF()
        for (ty in y0..y1) for (tx in x0..x1) {
            val wx = tx.mod(n)
            dst.set(
                (tx * tile - ox).toFloat(), (ty * tile - oy).toFloat(),
                ((tx + 1) * tile - ox).toFloat() + 0.5f, ((ty + 1) * tile - oy).toFloat() + 0.5f,
            )
            val bmp = tileBitmap(l, tz, wx, ty, load = true)
            if (bmp != null) { c.drawBitmap(bmp, null, dst, tilePaint); continue }
            // немає плитки — показуємо збільшений шматок з дрібнішого масштабу
            for (up in 1..4) {
                val pz = tz - up
                if (pz < 0) break
                val parent = tileBitmap(l, pz, wx shr up, ty shr up, load = up == 1) ?: continue
                val part = 256 shr up
                val sxp = (wx and ((1 shl up) - 1)) * part
                val syp = (ty and ((1 shl up) - 1)) * part
                val k = parent.width / 256f
                val src = Rect((sxp * k).toInt(), (syp * k).toInt(), ((sxp + part) * k).toInt(), ((syp + part) * k).toInt())
                c.drawBitmap(parent, src, dst, tilePaint)
                break
            }
        }
    }

    /** Плитка з памʼяті; якщо її там немає — фонове читання з диска (і з мережі, якщо можна). */
    private fun tileBitmap(l: Layers.Layer, z: Int, x: Int, y: Int, load: Boolean): Bitmap? {
        val url = Layers.url(l, z, x, y)
        val key = Layers.tileKey(url)
        val cached: Bitmap? = mem.get(key)
        if (cached != null) return cached
        if (load && !disposed && loading.add(key)) {
            try {
                io.execute {
                    try {
                        var data = TileStore.bytes(url)
                        if (data == null) {
                            val now = SystemClock.elapsedRealtime()
                            val lastFail = failed[key] ?: 0L
                            if (now > netPauseUntil && now - lastFail > 60_000) {
                                data = TileStore.download(url)
                                if (data == null) { failed[key] = now; netPauseUntil = now + 15_000 }
                            }
                        }
                        val bmp = data?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                        if (bmp != null) { mem.put(key, bmp); requestDrawFromIo() }
                    } finally {
                        loading.remove(key)
                    }
                }
            } catch (e: Exception) {
                loading.remove(key)   // пул уже зупинено
            }
        }
        return null
    }

    private fun requestDrawFromIo() { main.post { requestDraw() } }

    private inline fun drawLine(c: Canvas, size: Int, x: (Int) -> Float, y: (Int) -> Float, color: Int, w: Float) {
        val path = Path()
        path.moveTo(x(0), y(0))
        for (i in 1 until size) path.lineTo(x(i), y(i))
        line.color = Color.argb(140, 10, 13, 19)
        line.strokeWidth = (w + 3f) * density
        c.drawPath(path, line)
        line.color = color
        line.strokeWidth = w * density
        c.drawPath(path, line)
    }

    private fun drawPin(c: Canvas, x: Float, y: Float, icon: String, name: String, target: Boolean) {
        val r = 15f * density
        fill.color = if (target) Color.rgb(0x22, 0xe0, 0x6a) else Color.rgb(0x2a, 0x2d, 0x35)
        c.drawCircle(x, y - r, r, fill)
        fill.color = Color.WHITE
        fill.style = Paint.Style.STROKE; fill.strokeWidth = 2f * density
        c.drawCircle(x, y - r, r, fill)
        fill.style = Paint.Style.FILL
        text.textSize = 16f * density
        text.color = Color.WHITE
        c.drawText(icon, x, y - r + 6f * density, text)
        text.textSize = 12f * density
        text.setShadowLayer(3f, 0f, 0f, Color.BLACK)
        c.drawText(name, x, y + 14f * density, text)
        text.clearShadowLayer()
    }

    private fun drawMe(c: Canvas, x: Float, y: Float, loc: Location) {
        val r = 9f * density
        if (loc.hasBearing() && loc.hasSpeed() && loc.speed > 1.5f) {
            // стрілка за напрямком руху
            c.save()
            c.rotate(loc.bearing, x, y)
            val p = Path().apply {
                moveTo(x, y - r * 2.2f)
                lineTo(x + r * 1.4f, y + r * 1.4f)
                lineTo(x, y + r * 0.6f)
                lineTo(x - r * 1.4f, y + r * 1.4f)
                close()
            }
            fill.color = Color.rgb(0x00, 0xd4, 0xff)
            c.drawPath(p, fill)
            fill.color = Color.WHITE; fill.style = Paint.Style.STROKE; fill.strokeWidth = 2f * density
            c.drawPath(p, fill)
            fill.style = Paint.Style.FILL
            c.restore()
        } else {
            fill.color = Color.argb(60, 0x00, 0xd4, 0xff)
            c.drawCircle(x, y, r * 2.2f, fill)
            fill.color = Color.WHITE
            c.drawCircle(x, y, r + 2f * density, fill)
            fill.color = Color.rgb(0x00, 0xd4, 0xff)
            c.drawCircle(x, y, r, fill)
        }
    }

    companion object {
        private const val MIN_Z = 3
        private const val MAX_Z = 19
    }
}
