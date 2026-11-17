package io.github.fzn0x.nether;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What the share sheet hands Nether on Android (ADR 0087), which the page
 * reaches as {@code NetherInbox} (apps/desktop/src/mobile.ts). The app's
 * intent filters take text, links, images, PDFs, audio and video, one or
 * several; each share's files are copied from their content addresses into
 * the app's cache, in {@link Inbox}, and the page is told, which opens the
 * capture sheet. Only content addresses are read: a {@code file:} address
 * could name the app's own files.
 */
@CapacitorPlugin(name = "NetherInbox")
public class NetherInboxPlugin extends Plugin {

    private static final String TAG = "NetherInbox";

    /** One share at a time, each kept whole before the page hears of it. */
    private final ExecutorService copier = Executors.newSingleThreadExecutor();
    private Inbox inbox;

    @Override
    public void load() {
        try {
            inbox = new Inbox(new File(getContext().getCacheDir(), "inbox"));
            copier.execute(inbox::sweep);
        } catch (IOException e) {
            Logger.error(TAG, "The inbox could not be opened.", e);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // Opened again from the recent apps, the activity is handed the share it was started with.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        if (inbox == null) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String title = subject != null ? subject : intent.getStringExtra(Intent.EXTRA_TITLE);
        List<Inbox.Incoming> files = new ArrayList<>();
        ContentResolver resolver = getContext().getContentResolver();
        for (Uri uri : streamsOf(intent)) {
            if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) continue;
            String type = resolver.getType(uri);
            files.add(new Inbox.Incoming(displayName(resolver, uri), type == null ? intent.getType() : type, () -> {
                InputStream in = resolver.openInputStream(uri);
                if (in == null) throw new FileNotFoundException(uri.toString());
                return in;
            }));
        }
        String shared = text == null ? "" : text.toString();
        if (shared.trim().isEmpty() && files.isEmpty()) return;
        long at = System.currentTimeMillis();
        copier.execute(() -> {
            try {
                inbox.keep(shared, title, files, at);
                notifyListeners("shared", new JSObject(), true);
            } catch (IOException | SecurityException e) {
                Logger.error(TAG, "A share could not be kept.", e);
            }
        });
    }

    /** The content addresses a share names, each once: its stream, or its streams, and its clip. */
    @SuppressWarnings("deprecation")
    private static Set<Uri> streamsOf(Intent intent) {
        Set<Uri> uris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            Uri one = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        ClipData clip = intent.getClipData();
        if (clip != null && uris.isEmpty()) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        return uris;
    }

    /** The name the sharing app gives a file, or its address's last part. */
    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // A provider that answers no query still gives the bytes.
        }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    /** What was shared and is not filed or dropped yet, the oldest first. */
    @PluginMethod
    public void pending(PluginCall call) {
        copier.execute(() -> {
            JSArray captures = new JSArray();
            if (inbox != null) {
                for (Inbox.Shared shared : inbox.pending()) {
                    JSArray files = new JSArray();
                    for (Inbox.Item item : shared.files) {
                        JSObject file = new JSObject();
                        file.put("name", item.name);
                        file.put("type", item.type);
                        file.put("path", item.file.getAbsolutePath());
                        files.put(file);
                    }
                    JSObject capture = new JSObject();
                    capture.put("id", shared.id);
                    capture.put("at", shared.at);
                    capture.put("text", shared.text);
                    if (!shared.title.isEmpty()) capture.put("title", shared.title);
                    capture.put("files", files);
                    captures.put(capture);
                }
            }
            JSObject answer = new JSObject();
            answer.put("captures", captures);
            call.resolve(answer);
        });
    }

    /** Forgets a share, with its files. */
    @PluginMethod
    public void drop(PluginCall call) {
        String id = call.getString("id", "");
        copier.execute(() -> {
            try {
                if (inbox != null) inbox.drop(id);
                call.resolve();
            } catch (IOException e) {
                call.reject(e.getMessage(), e);
            }
        });
    }
}
