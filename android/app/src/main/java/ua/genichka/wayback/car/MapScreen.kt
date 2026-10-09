package ua.genichka.wayback.car

import android.content.Context
import android.location.Location
import android.os.SystemClock
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.versioning.CarAppApiLevels
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import ua.genichka.wayback.Geo
import ua.genichka.wayback.Layers
import ua.genichka.wayback.LocationHub
import ua.genichka.wayback.MainActivity
import ua.genichka.wayback.R
import ua.genichka.wayback.TrackService
import ua.genichka.wayback.TripStore
import ua.genichka.wayback.WebState

/** Екран WayBack в Android Auto: офлайн-карта, трек поїздки, точки з телефона. */
class MapScreen(ctx: CarContext) : Screen(ctx), DefaultLifecycleObserver {

    private val prefs = ctx.getSharedPreferences("wb", Context.MODE_PRIVATE)
    private val renderer = MapRenderer(ctx, prefs)
    private var lastInfo = ""
    private var lastInvalidate = 0L
    private var started = false

    private val onLoc: (Location) -> Unit = {
        renderer.onLocation(it)
        refreshInfo(false)
    }
    private val onWeb: () -> Unit = { renderer.post { renderer.requestDraw() } }

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreate(owner: LifecycleOwner) {
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(renderer)
        LocationHub.addListener(onLoc)
        WebState.addListener(onWeb)
        startIfAllowed()
    }

    override fun onDestroy(owner: LifecycleOwner) {
        LocationHub.removeListener(onLoc)
        WebState.removeListener(onWeb)
        LocationHub.release("car")
        renderer.dispose()
    }

    /** GPS і автозапис треку — як тільки є дозвіл на геолокацію. */
    private fun startIfAllowed() {
        if (started || !LocationHub.acquire(carContext, "car")) return
        started = true
        if (prefs.getBoolean("carAutoRec", true) && !TripStore.isRecording) {
            TripStore.start()
            TrackService.start(carContext)
        }
        LocationHub.last?.let { renderer.onLocation(it) }
    }

    override fun onGetTemplate(): Template {
        startIfAllowed()
        if (!started) {
            return MessageTemplate.Builder(
                "Відкрий WayBack на телефоні й дозволь доступ до геолокації, потім натисни «Готово»."
            )
                .setTitle("WayBack")
                .setHeaderAction(Action.APP_ICON)
                .addAction(Action.Builder().setTitle("Готово").setOnClickListener { invalidate() }.build())
                .build()
        }

        val rec = TripStore.isRecording
        val actions = ActionStrip.Builder()
            .addAction(
                Action.Builder().setTitle(if (rec) "Стоп" else "Запис")
                    .setOnClickListener { toggleRecording() }.build()
            )
            .addAction(Action.Builder().setTitle("Паркінг").setOnClickListener { markParking() }.build())
            .addAction(Action.Builder().setTitle("Шар").setOnClickListener { cycleLayer() }.build())
            .build()

        val map = ActionStrip.Builder()
        if (carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_2) map.addAction(Action.PAN)
        map.addAction(iconAction(R.drawable.ic_locate) { renderer.recenter() })
        map.addAction(iconAction(R.drawable.ic_plus) { renderer.zoomBy(1) })
        map.addAction(iconAction(R.drawable.ic_minus) { renderer.zoomBy(-1) })

        val (title, text) = infoText()
        lastInfo = title + text
        lastInvalidate = SystemClock.elapsedRealtime()
        val info = MessageInfo.Builder(title)
        if (text.isNotEmpty()) info.setText(text)

        return NavigationTemplate.Builder()
            .setActionStrip(actions)
            .setMapActionStrip(map.build())
            .setNavigationInfo(info.build())
            .build()
    }

    private fun iconAction(res: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setIcon(CarIcon.Builder(IconCompat.createWithResource(carContext, res)).build())
            .setOnClickListener { onClick() }
            .build()

    /** Картка зліва: довжина треку і відстань до цілі з телефона. */
    private fun infoText(): Pair<String, String> {
        val t = TripStore.current
        val title = if (t != null) "● Трек ${Geo.fmtDist(t.dist)}" else "Запис вимкнено"
        val here = LocationHub.last
        val tgt = WebState.target
        val text = if (here != null && tgt != null) {
            "${tgt.icon} ${tgt.name}: ${Geo.fmtDist(Geo.dist(here.latitude, here.longitude, tgt.lat, tgt.lon))}"
        } else ""
        return title to text
    }

    /** Оновлювати шаблон не частіше ніж раз на 5 с — так просить Android Auto. */
    private fun refreshInfo(force: Boolean) {
        val (title, text) = infoText()
        val now = SystemClock.elapsedRealtime()
        if (force || (title + text != lastInfo && now - lastInvalidate > 5000)) invalidate()
    }

    private fun toggleRecording() {
        if (TripStore.isRecording) {
            prefs.edit().putBoolean("carAutoRec", false).apply()
            val saved = TripStore.stop()
            TrackService.stop(carContext)
            toast(if (saved) "Трек збережено — він буде в історії на телефоні" else "Трек порожній, не збережено")
            MainActivity.notifyWeb()
        } else {
            prefs.edit().putBoolean("carAutoRec", true).apply()
            TripStore.start()
            TrackService.start(carContext)
            toast("Пишу трек")
        }
        renderer.requestDraw()
        refreshInfo(true)
    }

    private fun markParking() {
        val loc = LocationHub.last
        if (loc == null) { toast("Ще немає сигналу GPS"); return }
        TripStore.setParking(loc.latitude, loc.longitude)
        MainActivity.notifyWeb()
        toast("🚗 Місце машини збережено")
    }

    private fun cycleLayer() {
        val l = Layers.next(renderer.layerKey)
        renderer.layerKey = l.key
        toast("Карта: ${l.name}")
    }

    private fun toast(s: String) = CarToast.makeText(carContext, s, CarToast.LENGTH_LONG).show()
}
