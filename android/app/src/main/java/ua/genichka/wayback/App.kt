package ua.genichka.wayback

import android.content.Context

/** Спільна ініціалізація для телефона й машини — хто перший запустився, той і готує. */
object App {
    fun init(ctx: Context) {
        TileStore.init(ctx)
        TripStore.init(ctx)
        WebState.init(ctx)
    }
}
