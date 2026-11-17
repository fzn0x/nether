package io.github.fzn0x.nether;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;

/**
 * What the share sheet hands the app on Android (ADR 0087), kept in the
 * app's cache until the page files it as a note or drops it: each share a
 * folder named by its ID, holding a copy of each file shared and
 * {@code capture.properties}, its text, title and files. A share is made in
 * a folder of its own name with {@code .part} after it, then renamed, so
 * the page never reads half of one. Plain Java, so its tests run on the JVM.
 */
final class Inbox {

    static final String MANIFEST = "capture.properties";
    private static final String PART = ".part";
    /** The longest name a shared file keeps, before its extension. */
    private static final int LONGEST_NAME = 100;

    /** A file being shared: its name and type as the sharing app gave them, and its bytes. */
    static final class Incoming {
        final String name;
        final String type;
        final Source source;

        Incoming(String name, String type, Source source) {
            this.name = name == null ? "" : name;
            this.type = type == null ? "" : type;
            this.source = source;
        }
    }

    /** Where a shared file's bytes come from, opened once. */
    interface Source {
        InputStream open() throws IOException;
    }

    /** A file kept for a share. */
    static final class Item {
        final String name;
        final String type;
        final File file;

        Item(String name, String type, File file) {
            this.name = name;
            this.type = type;
            this.file = file;
        }
    }

    /** A share kept in the inbox. */
    static final class Shared {
        final String id;
        final long at;
        final String text;
        final String title;
        final List<Item> files;

        Shared(String id, long at, String text, String title, List<Item> files) {
            this.id = id;
            this.at = at;
            this.text = text;
            this.title = title;
            this.files = files;
        }
    }

    private final File root;

    Inbox(File root) throws IOException {
        this.root = root.getCanonicalFile();
    }

    File root() {
        return root;
    }

    /** Whether a file is one the inbox keeps, so only those move into a vault. */
    boolean holds(File file) throws IOException {
        String path = file.getCanonicalPath();
        return path.startsWith(root.getPath() + File.separator);
    }

    /**
     * Keeps a share: its text and title, and a copy of each file, under a new
     * ID, all or nothing. Gives what was kept.
     */
    Shared keep(String text, String title, List<Incoming> files, long at) throws IOException {
        String id = UUID.randomUUID().toString();
        File part = new File(root, id + PART);
        if (!part.mkdirs()) throw new IOException("The inbox could not make a folder for the share.");
        try {
            Properties manifest = new Properties();
            manifest.setProperty("at", Long.toString(at));
            manifest.setProperty("text", text == null ? "" : text);
            manifest.setProperty("title", title == null ? "" : title);
            Set<String> taken = new HashSet<>();
            taken.add(MANIFEST.toLowerCase(Locale.ROOT));
            int index = 0;
            for (Incoming incoming : files) {
                String name = freeName(fileName(incoming.name, incoming.type, index + 1), taken);
                File file = new File(part, name);
                try (InputStream in = incoming.source.open(); FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[64 * 1024];
                    for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
                    out.getFD().sync();
                }
                manifest.setProperty("file." + index + ".name", name);
                manifest.setProperty("file." + index + ".type", incoming.type);
                index++;
            }
            manifest.setProperty("files", Integer.toString(index));
            try (FileOutputStream out = new FileOutputStream(new File(part, MANIFEST));
                 Writer writer = new OutputStreamWriter(out, StandardCharsets.UTF_8)) {
                manifest.store(writer, null);
                writer.flush();
                out.getFD().sync();
            }
            File kept = new File(root, id);
            if (!part.renameTo(kept)) throw new IOException("The inbox could not keep the share.");
            return read(kept);
        } catch (IOException e) {
            deleteAll(part);
            throw e;
        }
    }

    /** The shares kept, the oldest first; half-made ones are left out. */
    List<Shared> pending() {
        List<Shared> list = new ArrayList<>();
        File[] folders = root.listFiles();
        if (folders == null) return list;
        for (File folder : folders) {
            if (!folder.isDirectory() || folder.getName().endsWith(PART)) continue;
            try {
                list.add(read(folder));
            } catch (IOException e) {
                // A share that cannot be read is left for drop, or the next start.
            }
        }
        Collections.sort(list, (a, b) -> Long.compare(a.at, b.at));
        return list;
    }

    /** Forgets a share and its files. */
    void drop(String id) throws IOException {
        if (id == null || id.isEmpty() || id.contains("/") || id.contains("\\") || id.startsWith(".")) {
            throw new IOException("\"" + id + "\" is not a share of the inbox.");
        }
        deleteAll(new File(root, id));
    }

    /** Drops what a share left half made, as when the app was ended while it copied. */
    void sweep() {
        File[] folders = root.listFiles();
        if (folders == null) return;
        for (File folder : folders) if (folder.getName().endsWith(PART)) deleteAll(folder);
    }

    private Shared read(File folder) throws IOException {
        Properties manifest = new Properties();
        try (InputStream in = new FileInputStream(new File(folder, MANIFEST));
             Reader reader = new InputStreamReader(in, StandardCharsets.UTF_8)) {
            manifest.load(reader);
        }
        int count = Integer.parseInt(manifest.getProperty("files", "0"));
        List<Item> files = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String name = manifest.getProperty("file." + i + ".name", "");
            files.add(new Item(name, manifest.getProperty("file." + i + ".type", ""), new File(folder, name)));
        }
        return new Shared(
            folder.getName(),
            Long.parseLong(manifest.getProperty("at", "0")),
            manifest.getProperty("text", ""),
            manifest.getProperty("title", ""),
            files
        );
    }

    /**
     * A shared file's name in the inbox: its own, without what a file system
     * or a link cannot hold, or "Shared" and its number, with an extension
     * from its type when it has none.
     */
    static String fileName(String name, String type, int number) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|#^\\[\\]\\p{Cntrl}]", "-").trim();
        clean = clean.replaceAll("^[.\\s]+", "");
        if (clean.isEmpty()) clean = "Shared " + number + extensionOf(type);
        int dot = clean.lastIndexOf('.');
        String stem = dot > 0 ? clean.substring(0, dot) : clean;
        String extension = dot > 0 ? clean.substring(dot) : "";
        if (stem.length() > LONGEST_NAME) stem = stem.substring(0, LONGEST_NAME).trim();
        return stem + extension;
    }

    /** An extension for a media type: `.jpg` for `image/jpeg`, none for one unknown. */
    static String extensionOf(String type) {
        if (type == null) return "";
        String lower = type.toLowerCase(Locale.ROOT);
        int slash = lower.indexOf('/');
        if (slash < 0 || lower.contains("*")) return "";
        String sub = lower.substring(slash + 1).replaceAll("[;+].*$", "");
        if (sub.equals("jpeg")) return ".jpg";
        if (sub.equals("plain")) return ".txt";
        if (sub.equals("markdown")) return ".md";
        if (sub.equals("quicktime")) return ".mov";
        if (sub.equals("mpeg") && lower.startsWith("audio/")) return ".mp3";
        return sub.matches("[a-z0-9]{1,8}") ? "." + sub : "";
    }

    /** The name, or a numbered one when another file of the share took it. */
    private static String freeName(String name, Set<String> taken) {
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        String candidate = name;
        for (int n = 1; taken.contains(candidate.toLowerCase(Locale.ROOT)); n++) {
            candidate = stem + " " + n + extension;
        }
        taken.add(candidate.toLowerCase(Locale.ROOT));
        return candidate;
    }

    static void deleteAll(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteAll(child);
        file.delete();
    }
}
