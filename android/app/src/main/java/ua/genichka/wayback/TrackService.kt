package ua.genichka.wayback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * Служба переднього плану: не дає системі приспати GPS, поки пишеться трек у машині
 * (навіть коли на екрані авто відкрита інша програма, напр. музика).
 */
class TrackService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        App.init(this)
        try {
            startForeground(NOTIF_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            LocationHub.acquire(this, "service")
        } catch (e: Exception) {
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onDestroy() {
        LocationHub.release("service")
        super.onDestroy()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Запис треку", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("WayBack")
            .setContentText("Пишу трек у машині")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL = "track"
        private const val NOTIF_ID = 17

        fun start(ctx: Context): Boolean {
            if (!LocationHub.hasPermission(ctx)) return false
            return try {
                ctx.startForegroundService(Intent(ctx, TrackService::class.java)); true
            } catch (e: Exception) {
                // Android 12+ іноді забороняє старт з фону — тоді GPS тримає сам екран машини
                false
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, TrackService::class.java)) } catch (e: Exception) { /* */ }
        }
    }
}
