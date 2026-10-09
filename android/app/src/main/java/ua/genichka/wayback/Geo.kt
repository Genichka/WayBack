package ua.genichka.wayback

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

object Geo {
    private const val R = 6371008.8

    /** Відстань у метрах, як dist() у app.js. */
    fun dist(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val h = sin(dLat / 2).let { it * it } +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).let { it * it }
        return 2 * R * asin(min(1.0, sqrt(h)))
    }

    fun fmtDist(m: Double): String = when {
        m < 1000 -> "${m.toInt()} м"
        m < 10000 -> String.format("%.2f км", m / 1000)
        else -> String.format("%.1f км", m / 1000)
    }
}
