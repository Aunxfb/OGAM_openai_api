package ai.offgridmobile.localserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import ai.offgridmobile.MainActivity
import ai.offgridmobile.R

/**
 * Keeps the local server alive with the screen off: an ongoing notification
 * (tap opens the app's Local Server screen via the launch extra) plus a
 * PARTIAL_WAKE_LOCK (CPU on, screen may sleep) AND a WifiLock so the radio
 * stays up for inbound LAN connections (a CPU-only wakelock lets the wifi
 * chip power-save, which drops LAN clients once the screen is off). Both are
 * held for the service's lifetime and released on destroy — never lingering.
 */
class LocalServerForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        showNotification(null)
        // CPU stays on so serving survives screen-off; the screen may sleep.
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OffGrid:LocalServer").apply {
            acquire() // indefinite — released in onDestroy
        }
        // Keep the wifi radio awake for inbound connections. HIGH_PERF is
        // deprecated on API 34+; LOW_LATENCY (Q+) is the modern equivalent
        // (wifi stays out of power-save). Falls back to FULL on older devices.
        try {
            val wifi = getSystemService(Context.WIFI_SERVICE) as WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifi.createWifiLock(mode, "OffGrid:LocalServer").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            // Radio lock unavailable (e.g. airplane mode) — the CPU wakelock
            // still holds; serving resumes when wifi is reachable.
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
        try { wifiLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        wifiLock = null
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
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
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
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
