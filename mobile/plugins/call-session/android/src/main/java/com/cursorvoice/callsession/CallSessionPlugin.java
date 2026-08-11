package com.cursorvoice.callsession;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CallSession")
public class CallSessionPlugin extends Plugin {
    private static final String CHANNEL_ID = "cursor_voice_call";
    private static final int NOTIFICATION_ID = 1001;
    private boolean callActive = false;

    @PluginMethod
    public void startCall(PluginCall call) {
        callActive = true;
        startForegroundNotification();
        call.resolve();
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        callActive = false;
        stopForegroundNotification();
        notifyListeners("callEnded", new JSObject());
        call.resolve();
    }

    @PluginMethod
    public void isCallActive(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("active", callActive);
        call.resolve(ret);
    }

    private void startForegroundNotification() {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "AgentVoice Session",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Active voice session with home Cursor bridge");
            nm.createNotificationChannel(channel);
        }

        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            ctx, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle("AgentVoice")
            .setContentText("Voice session active")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pi)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build();

        nm.notify(NOTIFICATION_ID, notification);
        notifyListeners("audioSessionActivated", new JSObject());
    }

    private void stopForegroundNotification() {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIFICATION_ID);
        notifyListeners("audioSessionDeactivated", new JSObject());
    }
}
