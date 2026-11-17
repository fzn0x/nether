package io.github.fzn0x.nether;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A vault's folder on the phone (ADR 0087): what needs the disk itself, as
 * the desktop's Go service does it. It lists, reads with each file's SHA-256,
 * and writes in one step: to a hidden temporary file beside the note, synced
 * to the disk, renamed over it, after checking the note is still what the
 * page last read. The page's DeviceFiles does the rest: the trash, free
 * names, and the errors the vault's files give. Plain Java, so its tests run
 * on the JVM; the plugin gives it the phone's way to rename and sync.
 */
final class VaultFolder {

    /** What a vault needs of the disk beyond java.io: an atomic rename, and syncing a folder. */
    interface Disk {
        /** Renames in one step, over a file that is there. */
        void replace(File from, File to) throws IOException;

        /** Flushes a folder's entries, so a rename survives a power cut. */
        void syncFolder(File folder);
    }

    /** A file: its path in the vault, its size, and when it last changed, in milliseconds. */
    static class Info {
        final String path;
        final long size;
        final long modified;

        Info(String path, long size, long modified) {
            this.path = path;
            this.size = size;
            this.modified = modified;
        }
    }

    /** A file and the SHA-256 of its bytes, in hexadecimal. */
    static class Hashed extends Info {
        final String hash;

        Hashed(Info info, String hash) {
            super(info.path, info.size, info.modified);
            this.hash = hash;
        }
    }

    /** A file's text: missing when it is not there, binary when it is not UTF-8. */
    static final class Text extends Hashed {
        final String text;
        final boolean missing;
        final boolean binary;

        Text(Info info, String hash, String text, boolean missing, boolean binary) {
            super(info, hash);
            this.text = text;
            this.missing = missing;
            this.binary = binary;
        }
    }

    /** A file's bytes. */
    static final class Bytes extends Hashed {
        final byte[] data;

        Bytes(Info info, String hash, byte[] data) {
            super(info, hash);
            this.data = data;
        }
    }

    static final String EXISTS = "exists";
    static final String CHANGED = "changed";
    static final String MISSING = "missing";

    private static final Pattern ID = Pattern.compile("\"id\"\\s*:\\s*\"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\"");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final File root;
    private final String rootPath;
    private final Disk disk;

    VaultFolder(File root, Disk disk) throws IOException {
        this.root = root.getCanonicalFile();
        this.rootPath = this.root.getPath();
        this.disk = disk;
    }

    File root() {
        return root;
    }

    /**
     * The file at a path of the vault. It refuses paths that are not the
     * vault's own: empty, absolute, with backslashes, or climbing out.
     */
    File resolve(String path) throws IOException {
        if (path.isEmpty() || path.startsWith("/") || path.contains("\\") || path.indexOf('\0') >= 0) {
            throw new IOException("\"" + path + "\" is not a path in the vault.");
        }
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                throw new IOException("\"" + path + "\" is not a path in the vault.");
            }
        }
        File file = new File(root, path);
        // A folder that is a link may not lead out of the vault.
        File parent = file.getParentFile();
        while (parent != null && !parent.exists()) parent = parent.getParentFile();
        if (parent != null) {
            String real = parent.getCanonicalPath();
            if (!real.equals(rootPath) && !real.startsWith(rootPath + File.separator)) {
                throw new IOException("\"" + path + "\" leads out of the vault.");
            }
        }
        return file;
    }

    private File folderAt(String folder) throws IOException {
        return folder.isEmpty() ? root : resolve(folder);
    }

    private Info infoOf(String path, File file) {
        return new Info(path, file.length(), file.lastModified());
    }

    /** A folder's entries, by name, so lists come in the same order each time. */
    private static String[] names(File folder) {
        String[] names = folder.list();
        if (names == null) return new String[0];
        Arrays.sort(names);
        return names;
    }

    /** Every file below a folder, hidden ones below it left out; none when it is not a folder. */
    List<Info> walk(String folder) throws IOException {
        List<Info> found = new ArrayList<>();
        File start = folderAt(folder);
        if (start.isDirectory()) filesIn(start, folder, found);
        return found;
    }

    private void filesIn(File folder, String prefix, List<Info> into) {
        for (String name : names(folder)) {
            if (name.startsWith(".")) continue;
            File child = new File(folder, name);
            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            if (child.isDirectory()) filesIn(child, path, into);
            else if (child.isFile()) into.add(infoOf(path, child));
        }
    }

    /** Every folder below a folder, hidden ones and what is in them left out. */
    List<String> folders(String folder) throws IOException {
        List<String> found = new ArrayList<>();
        File start = folderAt(folder);
        if (start.isDirectory()) foldersIn(start, folder, found);
        return found;
    }

    private void foldersIn(File folder, String prefix, List<String> into) {
        for (String name : names(folder)) {
            if (name.startsWith(".")) continue;
            File child = new File(folder, name);
            if (!child.isDirectory()) continue;
            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            into.add(path);
            foldersIn(child, path, into);
        }
    }

    /** The files that are there, of those asked, in order. */
    List<Info> stat(List<String> paths) throws IOException {
        List<Info> found = new ArrayList<>();
        for (String path : paths) {
            File file = resolve(path);
            if (file.isFile()) found.add(infoOf(path, file));
        }
        return found;
    }

    /** Files' text and hashes, in order, as the vault's files read them. */
    List<Text> readText(List<String> paths) throws IOException {
        List<Text> found = new ArrayList<>();
        for (String path : paths) {
            File file = resolve(path);
            if (!file.isFile()) {
                found.add(new Text(new Info(path, 0, 0), "", "", true, false));
                continue;
            }
            Info info = infoOf(path, file);
            byte[] data = read(file);
            String hash = sha256(data);
            String text = utf8(data);
            found.add(text == null ? new Text(info, hash, "", false, true) : new Text(info, hash, text, false, false));
        }
        return found;
    }

    /** A file's bytes and hash; null when it is not there. */
    Bytes readBytes(String path) throws IOException {
        File file = resolve(path);
        if (!file.isFile()) return null;
        Info info = infoOf(path, file);
        byte[] data = read(file);
        return new Bytes(info, sha256(data), data);
    }

    /**
     * Writes a file in one step, making its folders, if it is still {@code
     * base}: the hash of its bytes last read, or "" for a file that must not be
     * there. Gives the file as written, or {@link #EXISTS} or {@link #CHANGED}.
     */
    synchronized Object write(String path, byte[] data, String base) throws IOException {
        File file = resolve(path);
        boolean there = file.exists();
        if (base.isEmpty() && there) return EXISTS;
        if (!base.isEmpty() && (!file.isFile() || !sha256(read(file)).equals(base))) return CHANGED;
        File folder = file.getParentFile();
        if (folder != null && !folder.isDirectory() && !folder.mkdirs()) {
            throw new IOException(path + ": its folder could not be made.");
        }
        File temp = File.createTempFile("." + file.getName() + ".", ".tmp", folder);
        boolean done = false;
        try {
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(data);
                out.flush();
                out.getFD().sync();
            }
            disk.replace(temp, file);
            done = true;
        } finally {
            if (!done) temp.delete();
        }
        disk.syncFolder(folder);
        return new Hashed(infoOf(path, file), sha256(data));
    }

    /**
     * Moves a file, making the folders it needs: {@link #MISSING} when none
     * is at {@code from}, else {@link #EXISTS} when anything is at {@code to}.
     */
    synchronized Object move(String from, String to) throws IOException {
        File source = resolve(from);
        File target = resolve(to);
        if (!source.isFile()) return MISSING;
        if (target.exists() && !source.getCanonicalPath().equals(target.getCanonicalPath())) return EXISTS;
        File folder = target.getParentFile();
        if (folder != null && !folder.isDirectory() && !folder.mkdirs()) {
            throw new IOException(to + ": its folder could not be made.");
        }
        disk.replace(source, target);
        disk.syncFolder(folder);
        disk.syncFolder(source.getParentFile());
        return infoOf(to, target);
    }

    /** Deletes a file, and nothing else; false when none is there. */
    synchronized boolean delete(String path) throws IOException {
        File file = resolve(path);
        if (!file.isFile()) return false;
        if (!file.delete()) throw new IOException(path + " could not be deleted.");
        disk.syncFolder(file.getParentFile());
        return true;
    }

    /** Makes a folder and those it is in: "exists" when a file or folder is there. */
    synchronized String makeFolder(String path) throws IOException {
        File folder = resolve(path);
        if (folder.exists()) return EXISTS;
        if (!folder.mkdirs()) throw new IOException(path + ": the folder could not be made.");
        return "made";
    }

    /** Deletes an empty folder: "missing" when there is none, "full" when anything is in it. */
    synchronized String removeFolder(String path) throws IOException {
        File folder = resolve(path);
        if (!folder.isDirectory()) return MISSING;
        if (names(folder).length > 0) return "full";
        if (!folder.delete()) throw new IOException(path + ": the folder could not be removed.");
        return "removed";
    }

    /**
     * The vault's ID, from its {@code .nether/vault.json}, as the desktop app
     * keeps it there, so a vault copied from one to the other keeps its ID;
     * written the first time.
     */
    synchronized String id() throws IOException {
        File file = new File(root, ".nether/vault.json");
        if (file.isFile()) {
            Matcher found = ID.matcher(new String(read(file), StandardCharsets.UTF_8));
            if (found.find()) return found.group(1);
        }
        String id = uuidV7(System.currentTimeMillis());
        String json = "{\n  \"id\": \"" + id + "\",\n  \"format\": 1\n}\n";
        Object written = write(".nether/vault.json", json.getBytes(StandardCharsets.UTF_8),
            file.isFile() ? sha256(read(file)) : "");
        if (!(written instanceof Hashed)) throw new IOException("The vault's ID could not be kept.");
        return id;
    }

    /**
     * The folder a vault of that name is kept in: the name, without what a
     * path or a hidden name would read in it; "Notes" when nothing is left.
     */
    static String folderName(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").trim();
        while (cleaned.startsWith(".")) cleaned = cleaned.substring(1).trim();
        if (cleaned.length() > 100) cleaned = cleaned.substring(0, 100).trim();
        return cleaned.isEmpty() ? "Notes" : cleaned;
    }

    /** A UUID version 7 (RFC 9562), as the TypeScript core and the Go service make them. */
    static String uuidV7(long millis) {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        for (int i = 0; i < 6; i++) b[i] = (byte) (millis >>> (40 - 8 * i));
        b[6] = (byte) ((b[6] & 0x0f) | 0x70);
        b[8] = (byte) ((b[8] & 0x3f) | 0x80);
        StringBuilder hex = new StringBuilder(36);
        for (int i = 0; i < 16; i++) {
            if (i == 4 || i == 6 || i == 8 || i == 10) hex.append('-');
            hex.append(String.format(Locale.ROOT, "%02x", b[i] & 0xff));
        }
        return hex.toString();
    }

    static byte[] read(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(32, file.length()));
            byte[] chunk = new byte[64 * 1024];
            for (int n; (n = in.read(chunk)) > 0; ) out.write(chunk, 0, n);
            return out.toByteArray();
        }
    }

    /** UTF-8 text, a byte order mark kept; null when the bytes are not UTF-8. */
    static String utf8(byte[] data) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(data))
                .toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    static String sha256(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder hex = new StringBuilder(64);
            for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
