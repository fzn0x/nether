// A vault's folder on the phone (ADR 0087), on iOS: what the page's
// DeviceFiles counts on, and a write that never leaves half a note. The same
// cases as the Android app's VaultFolderTest.java.
import Foundation
import XCTest

@testable import Vaults

/// The phone's rename and sync, or a rename that fails, as a crash between
/// the temporary file and its rename would leave it.
final class CrashingDisk: Disk {
    var crash = false
    private let phone = PhoneDisk()

    func replace(_ from: String, with to: String) throws {
        if crash { throw VaultError("The app was ended before the rename.") }
        try phone.replace(from, with: to)
    }

    func syncFolder(_ folder: String) {
        phone.syncFolder(folder)
    }
}

final class VaultFolderTests: XCTestCase {
    private var temporary = ""
    private var disk = CrashingDisk()
    private var folder = VaultFolder(root: "/")

    override func setUpWithError() throws {
        temporary = NSTemporaryDirectory() + "vault-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: temporary + "/vault", withIntermediateDirectories: true)
        disk = CrashingDisk()
        folder = VaultFolder(root: temporary + "/vault", disk: disk)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: temporary)
    }

    private func utf8(_ text: String) -> Data {
        Data(text.utf8)
    }

    private func written(_ result: Written) throws -> FileInfo {
        guard case .written(let file) = result else {
            throw VaultError("Expected a write, got \(result).")
        }
        return file
    }

    private func pathsOf(_ files: [FileInfo]) -> [String] {
        files.map(\.path).sorted()
    }

    func testWritesANewFileAndReadsItBackWithItsHash() throws {
        let file = try written(folder.write("Projects/Plan.md", utf8("# Plan\n"), base: ""))
        XCTAssertEqual(file.path, "Projects/Plan.md")
        XCTAssertEqual(file.size, 7)
        XCTAssertEqual(file.hash, VaultFolder.sha256(utf8("# Plan\n")))

        let text = try folder.readText(["Projects/Plan.md"])[0]
        XCTAssertEqual(text.text, "# Plan\n")
        XCTAssertEqual(text.file.hash, file.hash)
        XCTAssertFalse(text.missing)
        XCTAssertFalse(text.binary)
    }

    func testHashesAsSha256Does() {
        XCTAssertEqual(
            VaultFolder.sha256(Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(
            VaultFolder.sha256(utf8("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testRefusesToWriteOverAFileThatIsThereOrChanged() throws {
        let first = try written(folder.write("Welcome.md", utf8("one"), base: ""))
        XCTAssertEqual(try folder.write("Welcome.md", utf8("two"), base: ""), .exists)
        XCTAssertEqual(try folder.write("Welcome.md", utf8("two"), base: "not its hash"), .changed)
        XCTAssertEqual(try folder.write("Nowhere.md", utf8("two"), base: first.hash ?? ""), .changed)
        _ = try written(folder.write("Welcome.md", utf8("two"), base: first.hash ?? ""))
        XCTAssertEqual(try folder.readText(["Welcome.md"])[0].text, "two")
    }

    func testAWriteCutShortLeavesTheOldTextAndNoTemporaryFile() throws {
        let first = try written(folder.write("Welcome.md", utf8("kept"), base: ""))
        disk.crash = true
        XCTAssertThrowsError(try folder.write("Welcome.md", utf8("lost"), base: first.hash ?? ""))
        disk.crash = false
        XCTAssertEqual(try folder.readText(["Welcome.md"])[0].text, "kept")
        let left = try FileManager.default.contentsOfDirectory(atPath: folder.root).sorted()
        XCTAssertEqual(left, ["Welcome.md"])
    }

    func testReadsMissingAndBinaryFilesAsTheVaultDoes() throws {
        _ = try written(folder.write("raw.bin", Data([0xff, 0xfe, 0]), base: ""))
        _ = try written(folder.write("bom.md", Data([0xef, 0xbb, 0xbf, 0x68, 0x69]), base: ""))
        let texts = try folder.readText(["Nowhere.md", "raw.bin", "bom.md"])
        XCTAssertTrue(texts[0].missing)
        XCTAssertEqual(texts[0].file.hash, "")
        XCTAssertTrue(texts[1].binary)
        XCTAssertEqual(texts[1].text, "")
        // The byte order mark stays, so the text writes back as the same bytes.
        XCTAssertEqual(texts[2].text, "\u{FEFF}hi")
        XCTAssertEqual(Array(texts[2].text.utf8), [0xef, 0xbb, 0xbf, 0x68, 0x69])
        XCTAssertNil(try folder.readBytes("Nowhere.md"))
        XCTAssertEqual(try folder.readBytes("raw.bin")?.data, Data([0xff, 0xfe, 0]))
    }

    func testWalksFilesAndFoldersLeavingHiddenOnesOut() throws {
        _ = try written(folder.write("Welcome.md", utf8("a"), base: ""))
        _ = try written(folder.write("Projects/2026/Plan.md", utf8("b"), base: ""))
        _ = try written(folder.write(".nether/settings.json", utf8("{}"), base: ""))
        _ = try written(folder.write("Projects/.hidden/secret.md", utf8("c"), base: ""))
        XCTAssertEqual(try folder.makeFolder("Empty"), "made")
        XCTAssertEqual(pathsOf(try folder.walk("")), ["Projects/2026/Plan.md", "Welcome.md"])
        XCTAssertEqual(pathsOf(try folder.walk("Projects")), ["Projects/2026/Plan.md"])
        XCTAssertEqual(pathsOf(try folder.walk(".nether")), [".nether/settings.json"])
        XCTAssertTrue(try folder.walk("Nowhere").isEmpty)
        XCTAssertEqual(try folder.folders("").sorted(), ["Empty", "Projects", "Projects/2026"])
        XCTAssertEqual(pathsOf(try folder.stat(["Welcome.md", "Nowhere.md"])), ["Welcome.md"])
    }

    func testMovesAFileButNeverOverAnother() throws {
        _ = try written(folder.write("Plan.md", utf8("plan"), base: ""))
        _ = try written(folder.write("Taken.md", utf8("taken"), base: ""))
        XCTAssertEqual(try folder.move("Nowhere.md", to: "Here.md"), .missing)
        XCTAssertEqual(try folder.move("Plan.md", to: "Taken.md"), .exists)
        guard case .moved(let moved) = try folder.move("Plan.md", to: ".trash/Plan.md") else {
            return XCTFail("The note should have moved.")
        }
        XCTAssertEqual(moved.path, ".trash/Plan.md")
        XCTAssertEqual(moved.size, 4)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.root + "/Plan.md"))
        XCTAssertTrue(try folder.delete(".trash/Plan.md"))
        XCTAssertFalse(try folder.delete(".trash/Plan.md"))
    }

    func testMakesAndRemovesFolders() throws {
        XCTAssertEqual(try folder.makeFolder("Ideas/Garden"), "made")
        XCTAssertEqual(try folder.makeFolder("Ideas/Garden"), VaultFolder.exists)
        _ = try written(folder.write("Ideas/note.md", utf8("x"), base: ""))
        XCTAssertEqual(try folder.makeFolder("Ideas/note.md"), VaultFolder.exists)
        XCTAssertEqual(try folder.removeFolder("Ideas"), "full")
        XCTAssertEqual(try folder.removeFolder("Ideas/Garden"), "removed")
        XCTAssertEqual(try folder.removeFolder("Ideas/Garden"), VaultFolder.missing)
    }

    func testRefusesPathsThatLeaveTheVault() {
        for path in ["", "../secret.md", "/etc/hosts", "a\\b.md", "a//b.md", "./a.md", "a/../b.md"] {
            XCTAssertThrowsError(try folder.resolve(path), path) { error in
                XCTAssertTrue((error as? VaultError)?.message.contains("not a path in the vault") == true, path)
            }
        }
    }

    func testRefusesAFolderThatLinksOutOfTheVault() throws {
        try FileManager.default.createDirectory(atPath: temporary + "/outside", withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            atPath: folder.root + "/Linked", withDestinationPath: temporary + "/outside")
        XCTAssertThrowsError(try folder.resolve("Linked/secret.md")) { error in
            XCTAssertTrue((error as? VaultError)?.message.contains("leads out of the vault") == true)
        }
    }

    func testKeepsTheVaultsIdInItsFolderAsTheDesktopAppDoes() throws {
        let id = try folder.id()
        XCTAssertTrue(VaultFolder.isUUID(id))
        XCTAssertEqual(Array(id)[14], "7")
        XCTAssertEqual(try folder.id(), id)
        XCTAssertEqual(try VaultFolder(root: folder.root, disk: disk).id(), id)
        let json = try String(contentsOfFile: folder.root + "/.nether/vault.json", encoding: .utf8)
        XCTAssertTrue(json.contains("\"id\": \"\(id)\""))
    }

    func testNamesAFolderAfterTheVaultWithoutWhatAPathWouldRead() {
        XCTAssertEqual(VaultFolder.folderName("Notes"), "Notes")
        XCTAssertEqual(VaultFolder.folderName("Work/Plans"), "Work-Plans")
        XCTAssertEqual(VaultFolder.folderName("..secret"), "secret")
        XCTAssertEqual(VaultFolder.folderName("  "), "Notes")
        XCTAssertEqual(VaultFolder.folderName(String(repeating: "a", count: 150)).count, 100)
    }

    func testMakesTimeOrderedUuidsOfVersionSeven() {
        let early = VaultFolder.uuidV7(1_000_000)
        let late = VaultFolder.uuidV7(2_000_000)
        XCTAssertEqual(Array(early)[14], "7")
        XCTAssertTrue(VaultFolder.isUUID(early))
        XCTAssertLessThan(String(early.prefix(13)), String(late.prefix(13)))
    }
}
