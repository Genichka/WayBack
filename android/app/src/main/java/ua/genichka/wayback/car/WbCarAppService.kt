package ua.genichka.wayback.car

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import ua.genichka.wayback.App
import ua.genichka.wayback.LocationHub
import ua.genichka.wayback.MainActivity
import ua.genichka.wayback.TrackService
import ua.genichka.wayback.TripStore

/** Точка входу Android Auto. */
class WbCarAppService : CarAppService() {
    // Особистий додаток, ставиться не з Play — довіряємо будь-якому хосту Android Auto.
    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onCreateSession(): Session = WbSession()
}

/** Сесія живе, поки телефон підключений до машини. */
class WbSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        App.init(carContext)
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) = onDisconnected()
        })
        return MapScreen(carContext)
    }

    /** Відключились від машини: закриваємо трек і запамʼятовуємо, де стоїть авто. */
    private fun onDisconnected() {
        val ctx = carContext.applicationContext
        TripStore.stop()
        LocationHub.last?.let { loc ->
            // позиція свіжа (до 5 хв) — значить, це і є місце, де лишили машину
            if (System.currentTimeMillis() - loc.time < 5 * 60_000) TripStore.setParking(loc.latitude, loc.longitude)
        }
        TrackService.stop(ctx)
        MainActivity.notifyWeb()
    }
}
