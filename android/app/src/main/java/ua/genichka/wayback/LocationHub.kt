package ua.genichka.wayback

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Єдине джерело GPS для машини. Тримають його екран Android Auto і служба запису.
 * Кожна нова позиція одразу йде в TripStore (якщо триває запис) і слухачам (карта в авто).
 */
object LocationHub {
    private val holders = mutableSetOf<String>()
    private val listeners = CopyOnWriteArraySet<(Location) -> Unit>()
    private var lm: LocationManager? = null
    private var lastGpsAt = 0L

    @Volatile
    var last: Location? = null
        private set

    fun hasPermission(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun addListener(l: (Location) -> Unit) { listeners.add(l) }
    fun removeListener(l: (Location) -> Unit) { listeners.remove(l) }

    // усі методи явно — на Android 10 частина з них ще не має типової реалізації
    private val callback = object : LocationListener {
        override fun onLocationChanged(loc: Location) = onLocation(loc)
        @Deprecated("old API")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    /** Почати слухати GPS від імені [who]. false — немає дозволу на геолокацію. */
    @SuppressLint("MissingPermission")
    @Synchronized
    fun acquire(ctx: Context, who: String): Boolean {
        if (!hasPermission(ctx)) return false
        if (!holders.add(who) || holders.size > 1) return true
        val m = ctx.applicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        lm = m
        try {
            if (last == null) {
                last = listOfNotNull(
                    runCatching { m.getLastKnownLocation(LocationManager.GPS_PROVIDER) }.getOrNull(),
                    runCatching { m.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) }.getOrNull(),
                ).maxByOrNull { it.time }
            }
            if (m.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                m.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, callback, Looper.getMainLooper())
            }
            if (m.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                m.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 3000L, 0f, callback, Looper.getMainLooper())
            }
        } catch (e: Exception) {
            holders.remove(who)
            return false
        }
        return true
    }

    @Synchronized
    fun release(who: String) {
        if (!holders.remove(who) || holders.isNotEmpty()) return
        try { lm?.removeUpdates(callback) } catch (e: Exception) { /* */ }
        lm = null
    }

    private fun onLocation(loc: Location) {
        val now = SystemClock.elapsedRealtime()
        if (loc.provider == LocationManager.GPS_PROVIDER) lastGpsAt = now
        // мережеву позицію беремо лише коли GPS мовчить понад 10 с (тунель, парковка)
        else if (now - lastGpsAt < 10_000) return
        last = loc
        TripStore.onLocation(loc)
        for (l in listeners) l(loc)
    }
}
