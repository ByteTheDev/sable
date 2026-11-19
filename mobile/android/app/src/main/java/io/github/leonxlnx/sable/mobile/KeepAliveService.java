package io.github.leonxlnx.sable.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app's connection to the desktop while a chat runs or waits and the app is in the
 * background. Android cuts the network of an app in the background, so without it the phone
 * would hear nothing until it is opened again (no "Done", no "Waiting for you").
 *
 * The page arms it (`KeepAlivePlugin.arm`) with a line for the notification while something runs
 * and disarms it when nothing does; the activity starts it when it leaves the screen (the one
 * moment Android allows a foreground service to start) and stops it when it comes back. It stops
 * itself after three hours at most.
 */
public class KeepAliveService extends Service {
    private static final String CHANNEL = "link";
    private static final int ID = 7001;
    private static final long MAX_MS = 3 * 60 * 60 * 1000L;

    /** The notification's line while something runs; null when nothing does. */
    static volatile String armed;
    static volatile boolean running;

    private final Handler handler = new Handler(Looper.getMainLooper());

    static void onAppHidden(Context context) {
        if (armed == null || running) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, KeepAliveService.class));
        } catch (Exception ignored) {
            // Not allowed now (Android decides): the app simply hears nothing in the background.
        }
    }

    static void stop(Context context) {
        if (!running) return;
        context.stopService(new Intent(context, KeepAliveService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_MIN);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String line = armed != null ? armed : "Following your chats";
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sable)
            .setColor(0xFFF2F1EE)
            .setContentTitle(line)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(tap)
            .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(ID, n);
            running = true;
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::stopSelf, MAX_MS);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
