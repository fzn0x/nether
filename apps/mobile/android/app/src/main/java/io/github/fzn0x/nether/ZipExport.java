package io.github.fzn0x.nether;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * An export's ZIP on Android (ADR 0087), written in the app's cache from
 * text the page made and from the vault's own files, as Go writes it on the
 * desktop, with java.util.zip: the vault's files never cross the bridge.
 * The share sheet then sends it on. Plain Java, so its tests run on the JVM.
 */
final class ZipExport {

    private final File file;
    private final FileOutputStream out;
    private final ZipOutputStream zip;
    private final Set<String> names = new HashSet<>();

    ZipExport(File file) throws IOException {
        File folder = file.getParentFile();
        if (folder != null && !folder.isDirectory() && !folder.mkdirs()) {
            throw new IOException("The export's folder could not be made.");
        }
        this.file = file;
        this.out = new FileOutputStream(file);
        this.zip = new ZipOutputStream(out, StandardCharsets.UTF_8);
    }

    File file() {
        return file;
    }

    /** A path in the ZIP, as the page names it: relative, separated by slashes, never climbing out. */
    private String entryName(String path) throws IOException {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\") || path.indexOf('\0') >= 0) {
            throw new IOException("\"" + path + "\" is not a path for an export.");
        }
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                throw new IOException("\"" + path + "\" is not a path for an export.");
            }
        }
        if (!names.add(path)) throw new IOException(path + " is in the export twice.");
        return path;
    }

    /** Adds text the page made, as UTF-8. */
    void addText(String path, String text) throws IOException {
        zip.putNextEntry(new ZipEntry(entryName(path)));
        zip.write(text.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    /** Adds a file of the vault, as it is on the disk. */
    void addFile(String path, File source) throws IOException {
        ZipEntry entry = new ZipEntry(entryName(path));
        entry.setTime(source.lastModified());
        zip.putNextEntry(entry);
        try (InputStream in = new FileInputStream(source)) {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) != -1; ) zip.write(buffer, 0, read);
        }
        zip.closeEntry();
    }

    /** Completes the ZIP, on the disk. */
    File finish() throws IOException {
        zip.finish();
        zip.flush();
        out.getFD().sync();
        zip.close();
        return file;
    }

    /** Drops the ZIP, unfinished. */
    void cancel() {
        try {
            zip.close();
        } catch (IOException ignored) {
            // Deleted all the same.
        }
        file.delete();
    }
}
