package io.github.fzn0x.nether;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * A vault's folder on the phone (ADR 0087), on the JVM: what the page's
 * DeviceFiles counts on, and a write that never leaves half a note.
 */
public class VaultFolderTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    /** The JVM's rename stands in for the phone's: in one step, over a file that is there. */
    private static class JvmDisk implements VaultFolder.Disk {
        /** Renames that fail, as a crash between the temporary file and its rename would leave it. */
        boolean crash = false;

        @Override
        public void replace(File from, File to) throws IOException {
            if (crash) throw new IOException("The app was ended before the rename.");
            Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        }

        @Override
        public void syncFolder(File folder) {
            // The JVM has no portable way to sync a folder; the phone's does.
        }
    }

    private JvmDisk disk;
    private VaultFolder folder;

    @Before
    public void setUp() throws IOException {
        disk = new JvmDisk();
        folder = new VaultFolder(temp.newFolder("vault"), disk);
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static List<String> pathsOf(List<? extends VaultFolder.Info> infos) {
        List<String> paths = new ArrayList<>();
        for (VaultFolder.Info info : infos) paths.add(info.path);
        Collections.sort(paths);
        return paths;
    }

    @Test
    public void writesANewFileAndReadsItBackWithItsHash() throws IOException {
        Object written = folder.write("Projects/Plan.md", utf8("# Plan\n"), "");
        assertTrue(written instanceof VaultFolder.Hashed);
        VaultFolder.Hashed hashed = (VaultFolder.Hashed) written;
        assertEquals("Projects/Plan.md", hashed.path);
        assertEquals(7, hashed.size);
        assertEquals(VaultFolder.sha256(utf8("# Plan\n")), hashed.hash);

        VaultFolder.Text text = folder.readText(Arrays.asList("Projects/Plan.md")).get(0);
        assertEquals("# Plan\n", text.text);
        assertEquals(hashed.hash, text.hash);
        assertFalse(text.missing);
        assertFalse(text.binary);
    }

    @Test
    public void refusesToWriteOverAFileThatIsThereOrChanged() throws IOException {
        VaultFolder.Hashed first = (VaultFolder.Hashed) folder.write("Welcome.md", utf8("one"), "");
        assertEquals(VaultFolder.EXISTS, folder.write("Welcome.md", utf8("two"), ""));
        assertEquals(VaultFolder.CHANGED, folder.write("Welcome.md", utf8("two"), "not its hash"));
        assertEquals(VaultFolder.CHANGED, folder.write("Nowhere.md", utf8("two"), first.hash));
        assertTrue(folder.write("Welcome.md", utf8("two"), first.hash) instanceof VaultFolder.Hashed);
        assertEquals("two", folder.readText(Arrays.asList("Welcome.md")).get(0).text);
    }

    @Test
    public void aWriteCutShortLeavesTheOldTextAndNoTemporaryFile() throws IOException {
        VaultFolder.Hashed first = (VaultFolder.Hashed) folder.write("Welcome.md", utf8("kept"), "");
        disk.crash = true;
        try {
            folder.write("Welcome.md", utf8("lost"), first.hash);
            fail("The write should have failed.");
        } catch (IOException expected) {
            // As the app ended before the rename.
        }
        disk.crash = false;
        assertEquals("kept", folder.readText(Arrays.asList("Welcome.md")).get(0).text);
        String[] left = folder.root().list();
        Arrays.sort(left);
        assertArrayEquals(new String[] {"Welcome.md"}, left);
    }

    @Test
    public void readsMissingAndBinaryFilesAsTheVaultDoes() throws IOException {
        folder.write("raw.bin", new byte[] {(byte) 0xff, (byte) 0xfe, 0}, "");
        folder.write("bom.md", new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, 'h', 'i'}, "");
        List<VaultFolder.Text> texts = folder.readText(Arrays.asList("Nowhere.md", "raw.bin", "bom.md"));
        assertTrue(texts.get(0).missing);
        assertEquals("", texts.get(0).hash);
        assertTrue(texts.get(1).binary);
        assertEquals("", texts.get(1).text);
        // The byte order mark stays, so the text writes back as the same bytes.
        assertEquals((char) 0xFEFF + "hi", texts.get(2).text);
        assertNull(folder.readBytes("Nowhere.md"));
        assertArrayEquals(new byte[] {(byte) 0xff, (byte) 0xfe, 0}, folder.readBytes("raw.bin").data);
    }

    @Test
    public void walksFilesAndFoldersLeavingHiddenOnesOut() throws IOException {
        folder.write("Welcome.md", utf8("a"), "");
        folder.write("Projects/2026/Plan.md", utf8("b"), "");
        folder.write(".nether/settings.json", utf8("{}"), "");
        folder.write("Projects/.hidden/secret.md", utf8("c"), "");
        folder.makeFolder("Empty");
        assertEquals(Arrays.asList("Projects/2026/Plan.md", "Welcome.md"), pathsOf(folder.walk("")));
        assertEquals(Arrays.asList("Projects/2026/Plan.md"), pathsOf(folder.walk("Projects")));
        assertEquals(Arrays.asList(".nether/settings.json"), pathsOf(folder.walk(".nether")));
        assertTrue(folder.walk("Nowhere").isEmpty());
        List<String> folders = new ArrayList<>(folder.folders(""));
        Collections.sort(folders);
        assertEquals(Arrays.asList("Empty", "Projects", "Projects/2026"), folders);
        assertEquals(pathsOf(folder.stat(Arrays.asList("Welcome.md", "Nowhere.md"))), Arrays.asList("Welcome.md"));
    }

    @Test
    public void movesAFileButNeverOverAnother() throws IOException {
        folder.write("Plan.md", utf8("plan"), "");
        folder.write("Taken.md", utf8("taken"), "");
        assertEquals(VaultFolder.MISSING, folder.move("Nowhere.md", "Here.md"));
        assertEquals(VaultFolder.EXISTS, folder.move("Plan.md", "Taken.md"));
        Object moved = folder.move("Plan.md", ".trash/Plan.md");
        assertTrue(moved instanceof VaultFolder.Info);
        assertEquals(".trash/Plan.md", ((VaultFolder.Info) moved).path);
        assertFalse(new File(folder.root(), "Plan.md").exists());
        assertTrue(folder.delete(".trash/Plan.md"));
        assertFalse(folder.delete(".trash/Plan.md"));
    }

    @Test
    public void makesAndRemovesFolders() throws IOException {
        assertEquals("made", folder.makeFolder("Ideas/Garden"));
        assertEquals(VaultFolder.EXISTS, folder.makeFolder("Ideas/Garden"));
        folder.write("Ideas/note.md", utf8("x"), "");
        assertEquals(VaultFolder.EXISTS, folder.makeFolder("Ideas/note.md"));
        assertEquals("full", folder.removeFolder("Ideas"));
        assertEquals("removed", folder.removeFolder("Ideas/Garden"));
        assertEquals(VaultFolder.MISSING, folder.removeFolder("Ideas/Garden"));
    }

    @Test
    public void refusesPathsThatLeaveTheVault() {
        for (String path : new String[] {"", "../secret.md", "/etc/hosts", "a\\b.md", "a//b.md", "./a.md", "a/../b.md"}) {
            try {
                folder.resolve(path);
                fail(path + " should be refused.");
            } catch (IOException expected) {
                assertTrue(expected.getMessage().contains("not a path in the vault"));
            }
        }
    }

    @Test
    public void keepsTheVaultsIdInItsFolderAsTheDesktopAppDoes() throws IOException {
        String id = folder.id();
        assertTrue(id.matches("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
        assertEquals(id, folder.id());
        assertEquals(id, new VaultFolder(folder.root(), disk).id());
        String json = new String(Files.readAllBytes(new File(folder.root(), ".nether/vault.json").toPath()), StandardCharsets.UTF_8);
        assertTrue(json.contains("\"id\": \"" + id + "\""));
    }

    @Test
    public void namesAFolderAfterTheVaultWithoutWhatAPathWouldRead() {
        assertEquals("Notes", VaultFolder.folderName("Notes"));
        assertEquals("Work-Plans", VaultFolder.folderName("Work/Plans"));
        assertEquals("secret", VaultFolder.folderName("..secret"));
        assertEquals("Notes", VaultFolder.folderName("  "));
        assertEquals(100, VaultFolder.folderName(new String(new char[150]).replace('\0', 'a')).length());
    }

    @Test
    public void makesTimeOrderedUuidsOfVersionSeven() {
        String early = VaultFolder.uuidV7(1_000_000L);
        String late = VaultFolder.uuidV7(2_000_000L);
        assertEquals('7', early.charAt(14));
        assertTrue(early.substring(0, 13).compareTo(late.substring(0, 13)) < 0);
    }
}
