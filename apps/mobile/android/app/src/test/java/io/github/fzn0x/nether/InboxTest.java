package io.github.fzn0x.nether;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The share sheet's inbox on Android (ADR 0087), on the JVM: a share kept
 * whole or not at all, its files named for a vault, and dropped with them.
 */
public class InboxTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private Inbox inbox;

    @Before
    public void open() throws IOException {
        inbox = new Inbox(temp.newFolder("inbox"));
    }

    private static Inbox.Incoming file(String name, String type, String text) {
        return new Inbox.Incoming(name, type, () -> new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    public void keepsAShareWithItsTextTitleAndFiles() throws IOException {
        Inbox.Shared kept = inbox.keep(
            "Line one\nline two: ü",
            "A page",
            Arrays.asList(file("photo.jpg", "image/jpeg", "jpeg"), file("photo.jpg", "image/jpeg", "again")),
            42
        );
        List<Inbox.Shared> pending = inbox.pending();
        assertEquals(1, pending.size());
        Inbox.Shared read = pending.get(0);
        assertEquals(kept.id, read.id);
        assertEquals(42, read.at);
        assertEquals("Line one\nline two: ü", read.text);
        assertEquals("A page", read.title);
        assertEquals("photo.jpg", read.files.get(0).name);
        assertEquals("photo 1.jpg", read.files.get(1).name);
        assertEquals("image/jpeg", read.files.get(1).type);
        assertArrayEquals("again".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(read.files.get(1).file.toPath()));
        assertTrue(inbox.holds(read.files.get(0).file));
        assertFalse(inbox.holds(temp.newFile("elsewhere.txt")));
        assertFalse(inbox.holds(new File(inbox.root(), "../elsewhere.txt")));
    }

    @Test
    public void listsSharesOldestFirstAndDropsThemWithTheirFiles() throws IOException {
        Inbox.Shared later = inbox.keep("Later", "", Collections.singletonList(file("a.pdf", "application/pdf", "%PDF")), 20);
        Inbox.Shared sooner = inbox.keep("Sooner", null, Collections.emptyList(), 10);
        List<Inbox.Shared> pending = inbox.pending();
        assertEquals(sooner.id, pending.get(0).id);
        assertEquals(later.id, pending.get(1).id);
        inbox.drop(later.id);
        assertEquals(1, inbox.pending().size());
        assertFalse(new File(inbox.root(), later.id).exists());
        try {
            inbox.drop("../outside");
            fail("A path out of the inbox is no share.");
        } catch (IOException expected) {
            // Refused.
        }
    }

    @Test
    public void keepsNothingOfAShareWhoseFileCannotBeRead() throws IOException {
        Inbox.Incoming broken = new Inbox.Incoming("x.png", "image/png", () -> {
            throw new IOException("The provider went away.");
        });
        try {
            inbox.keep("", "", Arrays.asList(file("a.png", "image/png", "png"), broken), 1);
            fail("The share should not be kept.");
        } catch (IOException expected) {
            // Nothing kept.
        }
        assertEquals(0, inbox.pending().size());
        String[] left = inbox.root().list();
        assertEquals(0, left == null ? 0 : left.length);
    }

    @Test
    public void sweepsWhatAnEndedAppLeftHalfMade() throws IOException {
        assertTrue(new File(inbox.root(), "half.part").mkdirs());
        assertEquals(0, inbox.pending().size());
        inbox.sweep();
        assertFalse(new File(inbox.root(), "half.part").exists());
    }

    @Test
    public void namesFilesForAVault() {
        assertEquals("Plan -v2-- final.pdf", Inbox.fileName("Plan [v2]: final.pdf", "application/pdf", 1));
        assertEquals("hidden", Inbox.fileName("..hidden", "", 1));
        assertEquals("Shared 2.jpg", Inbox.fileName("", "image/jpeg", 2));
        assertEquals("Shared 1", Inbox.fileName(null, "*/*", 1));
        assertEquals(".txt", Inbox.extensionOf("text/plain; charset=utf-8"));
        assertEquals(".svg", Inbox.extensionOf("image/svg+xml"));
        assertEquals(".mp3", Inbox.extensionOf("audio/mpeg"));
        assertEquals(100 + ".png".length(), Inbox.fileName(new String(new char[150]).replace('\0', 'a') + ".png", "", 1).length());
    }
}
