package ai.offgridmobile.localserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import ai.offgridmobile.MainActivity
import ai.offgridmobile.R

/**
 * Keeps the local server alive with the screen off: an ongoing notification
 * (tap opens the app's Local Server screen via the launch extra) plus a
 * PARTIAL_WAKE_LOCK (CPU on, screen may sleep). Stopped with the server —
 * never lingering.
 */
class LocalServerForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        showNotification(null)
        // CPU stays on so serving survives screen-off; the screen may sleep.
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OffGrid:LocalServer").apply {
            acquire(12 * 60 * 60 * 1000L)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // System restart after the process died: the socket and the JS
            // bridge are gone, so claiming "running" would lie. Drop the
            // notification; the user restarts from the Local Server screen.
            stopSelf()
            return START_NOT_STICKY
        }
        showNotification(intent.getStringExtra(EXTRA_SUMMARY))
        return START_STICKY
    }

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
        super.onDestroy()
    }

    /** (Re)build the ongoing notification; also re-asserts foreground state. */
    private fun showNotification(summary: String?) {
        val openApp = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_OPEN_LOCAL_SERVER, true)
        }
        val pending = PendingIntent.getActivity(
            this, 0, openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Off Grid AI local server running")
            .setContentText(summary ?: "Serving the loaded model on your network")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pending)
            .setOngoing(true)
            .setAutoCancel(false)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Local server", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val CHANNEL_ID = "offgrid_local_server"
        const val NOTIFICATION_ID = 4201
        const val EXTRA_OPEN_LOCAL_SERVER = "openLocalServer"
        const val EXTRA_SUMMARY = "summary"

        fun start(context: Context, summary: String? = null) {
            val intent = Intent(context, LocalServerForegroundService::class.java).apply {
                putExtra(EXTRA_SUMMARY, summary)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocalServerForegroundService::class.java))
        }
    }
}
