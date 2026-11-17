package io.github.fzn0x.nether;

import android.os.Process;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The mobile apps' own plugin on Android (ADR 0087), which the page reaches as
 * {@code NetherVaults} (apps/desktop/src/mobile.ts). It keeps the list of the
 * phone's vaults, each a folder in the app's own files, and does to a vault's
 * folder what needs the disk, through {@link VaultFolder}, one call at a time
 * on a thread of its own.
 */
@CapacitorPlugin(name = "NetherVaults")
public class NetherVaultsPlugin extends Plugin {

    private static final String TAG = "NetherMarks";

    /** The phone's own rename, which replaces a file in one step, and its sync of a folder. */
    private static final VaultFolder.Disk DISK = new VaultFolder.Disk() {
        @Override
        public void replace(File from, File to) throws IOException {
            try {
                Os.rename(from.getPath(), to.getPath());
            } catch (ErrnoException e) {
                throw new IOException(e.getMessage(), e);
            }
        }

        @Override
        public void syncFolder(File folder) {
            if (folder == null) return;
            try {
                FileDescriptor fd = Os.open(folder.getPath(), OsConstants.O_RDONLY, 0);
                try {
                    Os.fsync(fd);
                } finally {
                    Os.close(fd);
                }
            } catch (ErrnoException ignored) {
                // A folder the system will not sync is written with its next sync.
            }
        }
    };

    /** One call at a time, so a write's check and its write see the same file. */
    private final ExecutorService disk = Executors.newSingleThreadExecutor();
    private final Map<String, VaultFolder> open = new HashMap<>();

    private interface Work {
        JSObject run() throws Exception;
    }

    /** Runs a call's work on the disk's thread, and answers it. */
    private void onDisk(PluginCall call, Work work) {
        disk.execute(() -> {
            try {
                JSObject answer = work.run();
                if (answer == null) call.resolve();
                else call.resolve(answer);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
            }
        });
    }

    // The list of vaults, in the app's own files, beside their folders.

    private File vaultsFolder() {
        return new File(getContext().getFilesDir(), "vaults");
    }

    private File registryFile() {
        return new File(getContext().getFilesDir(), "vaults.json");
    }

    private JSONObject registry() throws IOException, JSONException {
        File file = registryFile();
        if (!file.isFile()) return new JSONObject().put("vaults", new JSONArray());
        return new JSONObject(new String(VaultFolder.read(file), StandardCharsets.UTF_8));
    }

    private void saveRegistry(JSONObject registry) throws IOException, JSONException {
        saveJson(registryFile(), registry);
    }

    /** Writes a list in one step: to a temporary file, synced, then renamed over it. */
    private static void saveJson(File file, JSONObject json) throws IOException, JSONException {
        File temp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        DISK.replace(temp, file);
        DISK.syncFolder(file.getParentFile());
    }

    // The servers signed in to, with their accounts and without their tokens,
    // which the page keeps in the Keystore's care (ADR 0087).

    private File serversFile() {
        return new File(getContext().getFilesDir(), "servers.json");
    }

    private JSONArray serverList() throws IOException, JSONException {
        File file = serversFile();
        if (!file.isFile()) return new JSONArray();
        return new JSONObject(new String(VaultFolder.read(file), StandardCharsets.UTF_8)).getJSONArray("servers");
    }

    /** The list without the server at an address, and with {@code first} at its head, if given. */
    private void saveServers(JSONObject first, String without) throws IOException, JSONException {
        JSONArray before = serverList();
        JSONArray after = new JSONArray();
        if (first != null) after.put(first);
        for (int i = 0; i < before.length(); i++) {
            JSONObject each = before.getJSONObject(i);
            if (!each.optString("url").equals(without)) after.put(each);
        }
        saveJson(serversFile(), new JSONObject().put("servers", after));
    }

    @PluginMethod
    public void servers(PluginCall call) {
        onDisk(call, () -> {
            JSONArray kept = serverList();
            JSArray list = new JSArray();
            for (int i = 0; i < kept.length(); i++) list.put(kept.getJSONObject(i));
            return new JSObject().put("servers", list);
        });
    }

    @PluginMethod
    public void saveServer(PluginCall call) {
        JSObject account = call.getObject("account");
        onDisk(call, () -> {
            if (account == null || account.optString("url").isEmpty()) {
                throw new IOException("A server's account needs its address.");
            }
            saveServers(account, account.getString("url"));
            return null;
        });
    }

    @PluginMethod
    public void forgetServer(PluginCall call) {
        String url = call.getString("url", "");
        onDisk(call, () -> {
            saveServers(null, url);
            return null;
        });
    }

    private static JSONObject entryOf(JSONObject registry, String id) throws JSONException {
        JSONArray vaults = registry.getJSONArray("vaults");
        for (int i = 0; i < vaults.length(); i++) {
            JSONObject vault = vaults.getJSONObject(i);
            if (vault.getString("id").equals(id)) return vault;
        }
        return null;
    }

    private VaultFolder folderOf(String id) throws IOException, JSONException {
        VaultFolder found = open.get(id);
        if (found != null) return found;
        JSONObject entry = entryOf(registry(), id);
        if (entry == null) throw new IOException("No vault " + id + " is on this phone.");
        VaultFolder folder = new VaultFolder(new File(vaultsFolder(), entry.getString("folder")), DISK);
        open.put(id, folder);
        return folder;
    }

    private static JSObject vaultOf(JSONObject entry) throws JSONException {
        JSObject vault = new JSObject();
        vault.put("id", entry.getString("id"));
        vault.put("name", entry.getString("name"));
        vault.put("path", entry.getString("folder"));
        return vault;
    }

    @PluginMethod
    public void vaults(PluginCall call) {
        onDisk(call, () -> {
            JSONObject registry = registry();
            JSONArray vaults = registry.getJSONArray("vaults");
            JSArray list = new JSArray();
            for (int i = 0; i < vaults.length(); i++) list.put(vaultOf(vaults.getJSONObject(i)));
            JSObject answer = new JSObject();
            answer.put("vaults", list);
            if (registry.has("last")) answer.put("last", registry.getString("last"));
            return answer;
        });
    }

    @PluginMethod
    public void openVault(PluginCall call) {
        String id = call.getString("id");
        String name = call.getString("name");
        boolean fresh = Boolean.TRUE.equals(call.getBoolean("fresh", false));
        onDisk(call, () -> {
            JSONObject registry = registry();
            JSONObject known = id == null ? null : entryOf(registry, id);
            if (id != null && known == null) throw new IOException("No vault " + id + " is on this phone.");
            String shown = known != null ? known.getString("name") : (name == null ? "" : name.trim());
            String folderName = known != null ? known.getString("folder") : VaultFolder.folderName(shown);
            // A fresh vault, as a workspace opened on the phone, never takes a folder that is there.
            if (known == null && fresh) {
                String base = folderName;
                String named = shown.isEmpty() ? base : shown;
                for (int n = 2; new File(vaultsFolder(), folderName).exists(); n++) {
                    folderName = base + " " + n;
                    shown = named + " " + n;
                }
            }
            File root = new File(vaultsFolder(), folderName);
            if (!root.isDirectory() && !root.mkdirs()) throw new IOException("The vault's folder could not be made.");
            VaultFolder folder = new VaultFolder(root, DISK);
            String vaultId = folder.id();
            open.put(vaultId, folder);
            JSONObject entry = new JSONObject()
                .put("id", vaultId)
                .put("name", shown.isEmpty() ? folderName : shown)
                .put("folder", folderName);
            // The latest first, each vault and each folder once.
            JSONArray before = registry.getJSONArray("vaults");
            JSONArray after = new JSONArray().put(entry);
            for (int i = 0; i < before.length(); i++) {
                JSONObject each = before.getJSONObject(i);
                if (!each.getString("id").equals(vaultId) && !each.getString("folder").equals(folderName)) {
                    after.put(each);
                }
            }
            registry.put("vaults", after).put("last", vaultId);
            saveRegistry(registry);
            return vaultOf(entry);
        });
    }

    @PluginMethod
    public void forgetVault(PluginCall call) {
        String id = call.getString("id", "");
        onDisk(call, () -> {
            JSONObject registry = registry();
            JSONArray before = registry.getJSONArray("vaults");
            JSONArray after = new JSONArray();
            for (int i = 0; i < before.length(); i++) {
                JSONObject each = before.getJSONObject(i);
                if (!each.getString("id").equals(id)) after.put(each);
            }
            registry.put("vaults", after);
            if (id.equals(registry.optString("last"))) registry.remove("last");
            saveRegistry(registry);
            open.remove(id);
            return null;
        });
    }

    @PluginMethod
    public void root(PluginCall call) {
        String id = call.getString("id", "");
        onDisk(call, () -> new JSObject().put("path", folderOf(id).root().getAbsolutePath()));
    }

    // A vault's files.

    private static JSObject infoOf(VaultFolder.Info info) {
        JSObject file = new JSObject();
        file.put("path", info.path);
        file.put("size", info.size);
        file.put("modified", info.modified);
        if (info instanceof VaultFolder.Hashed) file.put("hash", ((VaultFolder.Hashed) info).hash);
        return file;
    }

    private static JSArray infosOf(List<? extends VaultFolder.Info> infos) {
        JSArray list = new JSArray();
        for (VaultFolder.Info info : infos) list.put(infoOf(info));
        return list;
    }

    private static List<String> pathsOf(PluginCall call) throws JSONException {
        JSArray paths = call.getArray("paths", new JSArray());
        return paths.toList();
    }

    @PluginMethod
    public void walk(PluginCall call) {
        String id = call.getString("id", "");
        String folder = call.getString("folder", "");
        onDisk(call, () -> new JSObject().put("files", infosOf(folderOf(id).walk(folder))));
    }

    @PluginMethod
    public void folders(PluginCall call) {
        String id = call.getString("id", "");
        String folder = call.getString("folder", "");
        onDisk(call, () -> new JSObject().put("folders", new JSArray(folderOf(id).folders(folder))));
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String id = call.getString("id", "");
        onDisk(call, () -> new JSObject().put("files", infosOf(folderOf(id).stat(pathsOf(call)))));
    }

    @PluginMethod
    public void readText(PluginCall call) {
        String id = call.getString("id", "");
        onDisk(call, () -> {
            JSArray files = new JSArray();
            for (VaultFolder.Text text : folderOf(id).readText(pathsOf(call))) {
                JSObject file = infoOf(text);
                file.put("text", text.text);
                if (text.missing) file.put("missing", true);
                if (text.binary) file.put("binary", true);
                files.put(file);
            }
            return new JSObject().put("files", files);
        });
    }

    @PluginMethod
    public void readBytes(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("path", "");
        onDisk(call, () -> {
            VaultFolder.Bytes bytes = folderOf(id).readBytes(path);
            JSObject answer = new JSObject();
            if (bytes != null) {
                JSObject file = infoOf(bytes);
                file.put("data", Base64.encodeToString(bytes.data, Base64.NO_WRAP));
                answer.put("file", file);
            }
            return answer;
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("path", "");
        String base = call.getString("base", "");
        String text = call.getString("text");
        String data = call.getString("data");
        onDisk(call, () -> {
            byte[] bytes = text != null ? text.getBytes(StandardCharsets.UTF_8) : Base64.decode(data == null ? "" : data, Base64.DEFAULT);
            Object written = folderOf(id).write(path, bytes, base);
            JSObject answer = new JSObject();
            if (written instanceof VaultFolder.Info) {
                answer.put("result", "written");
                answer.put("file", infoOf((VaultFolder.Info) written));
            } else {
                answer.put("result", written);
            }
            return answer;
        });
    }

    @PluginMethod
    public void move(PluginCall call) {
        String id = call.getString("id", "");
        String from = call.getString("from", "");
        String to = call.getString("to", "");
        onDisk(call, () -> {
            Object moved = folderOf(id).move(from, to);
            JSObject answer = new JSObject();
            if (moved instanceof VaultFolder.Info) {
                answer.put("result", "moved");
                answer.put("file", infoOf((VaultFolder.Info) moved));
            } else {
                answer.put("result", moved);
            }
            return answer;
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("path", "");
        onDisk(call, () -> new JSObject().put("deleted", folderOf(id).delete(path)));
    }

    @PluginMethod
    public void makeFolder(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("path", "");
        onDisk(call, () -> new JSObject().put("result", folderOf(id).makeFolder(path)));
    }

    @PluginMethod
    public void removeFolder(PluginCall call) {
        String id = call.getString("id", "");
        String path = call.getString("path", "");
        onDisk(call, () -> new JSObject().put("result", folderOf(id).removeFolder(path)));
    }

    /**
     * Writes a point the page reached to the system's log, with the
     * milliseconds since the app's process started, for tools/perf/android.mjs.
     */
    @PluginMethod
    public void mark(PluginCall call) {
        String name = call.getString("name", "");
        long since = SystemClock.uptimeMillis() - Process.getStartUptimeMillis();
        Log.i(TAG, name + " " + since);
        call.resolve();
    }
}
