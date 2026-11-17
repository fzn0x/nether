package io.github.fzn0x.nether;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * An export's ZIP on Android (ADR 0087), on the JVM: the page's text and
 * the vault's own files, by the paths the page gives, none climbing out.
 */
public class ZipExportTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void writesTextAndFilesAsTheyAre() throws IOException {
        File image = temp.newFile("photo.png");
        byte[] bytes = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0, 1, 2 };
        Files.write(image.toPath(), bytes);
        ZipExport zip = new ZipExport(new File(temp.getRoot(), "out/Vault.zip"));
        zip.addText("Notes/Ideas.md", "# Ideas\n\nü\n");
        zip.addFile("attachments/photo.png", image);
        File done = zip.finish();
        try (ZipFile read = new ZipFile(done)) {
            List<String> names = new ArrayList<>();
            for (ZipEntry entry : java.util.Collections.list(read.entries())) names.add(entry.getName());
            assertEquals(List.of("Notes/Ideas.md", "attachments/photo.png"), names);
            assertEquals(
                "# Ideas\n\nü\n",
                new String(read.getInputStream(read.getEntry("Notes/Ideas.md")).readAllBytes(), StandardCharsets.UTF_8)
            );
            assertArrayEquals(bytes, read.getInputStream(read.getEntry("attachments/photo.png")).readAllBytes());
        }
    }

    @Test
    public void refusesPathsOutOfTheExportAndTwiceTheSame() throws IOException {
        ZipExport zip = new ZipExport(new File(temp.getRoot(), "Vault.zip"));
        for (String path : new String[] { "", "/etc/passwd", "../up.md", "a//b.md", "a\\b.md", "./a.md" }) {
            try {
                zip.addText(path, "x");
                fail(path + " should be refused.");
            } catch (IOException expected) {
                // Refused.
            }
        }
        zip.addText("a.md", "x");
        try {
            zip.addText("a.md", "y");
            fail("The same path twice should be refused.");
        } catch (IOException expected) {
            // Refused.
        }
        zip.cancel();
        assertFalse(zip.file().exists());
    }
}
