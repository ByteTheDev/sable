package io.github.leonxlnx.sable.mobile;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * Files the agent handed over, downloaded inside the app: Android's DownloadManager fetches the
 * desktop's one-file link (`phone.fileLink`) into Downloads/Sable, the page reads its progress, and
 * Open hands the finished file to the app that opens its kind (an APK to the installer). The system
 * shows its own notification when a download is done.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private static long idOf(PluginCall call) {
        try {
            return Long.parseLong(call.getString("id", "-1"));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String mimeFor(String name, String given) {
        if (given != null && !given.isEmpty()) return given;
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        if (ext.equals("apk")) return "application/vnd.android.package-archive";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String name = call.getString("name");
        if (url == null || name == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("That file has no link.");
            return;
        }
        String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (safe.isEmpty() || safe.startsWith(".")) safe = "file" + safe;
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle(safe);
            String from = call.getString("from");
            if (from != null) r.setDescription(from);
            r.setMimeType(mimeFor(safe, call.getString("mime")));
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Downloads/Sable from Android 10 on (no permission needed there); before, the app's own folder.
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Sable/" + safe);
            else r.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, safe);
            long id = manager().enqueue(r);
            JSObject o = new JSObject();
            o.put("id", String.valueOf(id));
            call.resolve(o);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "The download could not start.");
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        long id = idOf(call);
        JSObject o = new JSObject();
        try (Cursor c = manager().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) {
                o.put("state", "gone");
                call.resolve(o);
                return;
            }
            int st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            String state;
            if (st == DownloadManager.STATUS_SUCCESSFUL) state = "done";
            else if (st == DownloadManager.STATUS_FAILED) state = "failed";
            else if (st == DownloadManager.STATUS_PAUSED) state = "paused";
            else if (st == DownloadManager.STATUS_RUNNING) state = "running";
            else state = "pending";
            o.put("state", state);
            o.put("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            o.put("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            o.put("reason", c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)));
            call.resolve(o);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "The download is not known.");
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        long id = idOf(call);
        Uri uri;
        try {
            uri = manager().getUriForDownloadedFile(id);
        } catch (Exception e) {
            uri = null;
        }
        if (uri == null) {
            call.reject("The file is no longer on this phone.");
            return;
        }
        String mime = call.getString("mime");
        if (mime == null || mime.isEmpty()) mime = manager().getMimeTypeForDownloadedFile(id);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, mime != null ? mime : "application/octet-stream");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone opens this kind of file.");
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        long id = idOf(call);
        try {
            manager().remove(id);
        } catch (Exception e) {
            // already gone
        }
        call.resolve();
    }
}
