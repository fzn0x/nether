// The share extension's inbox on iOS (ADR 0087), as the Android app's
// InboxTest.java has it: a capture kept whole or not at all, its files
// named for a vault, read back oldest first, and dropped with them; and the
// vaults the app offers the extension, the one opened last first.
import Foundation
import XCTest

@testable import Shares

final class CapturesTests: XCTestCase {
    private var temporary = URL(fileURLWithPath: "/")
    private var inbox = CaptureInbox(root: URL(fileURLWithPath: "/"))

    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        inbox = CaptureInbox(root: temporary.appendingPathComponent("Inbox", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporary)
    }

    private func file(_ name: String, _ text: String) throws -> URL {
        let url = temporary.appendingPathComponent(UUID().uuidString)
        try Data(text.utf8).write(to: url)
        return url
    }

    func testKeepsACaptureWithItsTextLinkVaultAndFiles() throws {
        let kept = try inbox.keep(
            text: "Line one\nline two: ü", title: "A page", url: "https://example.org", vault: "v1",
            newVault: " ",
            files: [
                IncomingFile(name: "photo.jpg", type: "public.jpeg", from: try file("a", "jpeg")),
                IncomingFile(name: "photo.jpg", type: "public.jpeg", from: try file("b", "again")),
            ],
            at: Date(timeIntervalSince1970: 42))
        let pending = inbox.pending()
        XCTAssertEqual(pending.count, 1)
        let read = try XCTUnwrap(pending.first)
        XCTAssertEqual(read.capture, kept)
        XCTAssertEqual(read.capture.at, 42_000)
        XCTAssertEqual(read.capture.text, "Line one\nline two: ü")
        XCTAssertEqual(read.capture.title, "A page")
        XCTAssertEqual(read.capture.url, "https://example.org")
        XCTAssertEqual(read.capture.vault, "v1")
        XCTAssertNil(read.capture.newVault)
        XCTAssertEqual(read.capture.files.map(\.name), ["photo.jpg", "photo 1.jpg"])
        let second = read.folder.appendingPathComponent("photo 1.jpg")
        XCTAssertEqual(try Data(contentsOf: second), Data("again".utf8))
        XCTAssertTrue(inbox.holds(second.path))
        XCTAssertFalse(inbox.holds(temporary.appendingPathComponent("elsewhere").path))
        XCTAssertFalse(inbox.holds(inbox.root.appendingPathComponent("../elsewhere").path))
    }

    func testListsCapturesOldestFirstAndDropsThemWithTheirFiles() throws {
        let later = try inbox.keep(
            text: "Later", title: nil, url: nil, vault: nil, newVault: nil, files: [],
            at: Date(timeIntervalSince1970: 20))
        let sooner = try inbox.keep(
            text: "Sooner", title: nil, url: nil, vault: nil, newVault: "Notes", files: [],
            at: Date(timeIntervalSince1970: 10))
        XCTAssertEqual(inbox.pending().map(\.capture.id), [sooner.id, later.id])
        XCTAssertEqual(inbox.pending().first?.capture.newVault, "Notes")
        try inbox.drop(later.id)
        XCTAssertEqual(inbox.pending().map(\.capture.id), [sooner.id])
        XCTAssertThrowsError(try inbox.drop("../outside"))
    }

    func testKeepsNothingOfACaptureWhoseFileCannotBeRead() throws {
        let missing = temporary.appendingPathComponent("gone.png")
        XCTAssertThrowsError(
            try inbox.keep(
                text: "", title: nil, url: nil, vault: nil, newVault: nil,
                files: [IncomingFile(name: "gone.png", type: "public.png", from: missing)],
                at: Date()))
        XCTAssertEqual(inbox.pending().count, 0)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: inbox.root.path), [])
    }

    func testSweepsWhatAnEndedExtensionLeftHalfMade() throws {
        let half = inbox.root.appendingPathComponent("half.part", isDirectory: true)
        try FileManager.default.createDirectory(at: half, withIntermediateDirectories: true)
        XCTAssertEqual(inbox.pending().count, 0)
        inbox.sweep()
        XCTAssertFalse(FileManager.default.fileExists(atPath: half.path))
    }

    func testNamesFilesForAVault() {
        XCTAssertEqual(
            CaptureInbox.fileName("Plan [v2]: final.pdf", type: "com.adobe.pdf", number: 1),
            "Plan -v2-- final.pdf")
        XCTAssertEqual(CaptureInbox.fileName("..hidden", type: "", number: 1), "hidden")
        XCTAssertEqual(CaptureInbox.fileName("", type: "public.jpeg", number: 2), "Shared 2.jpg")
        XCTAssertEqual(CaptureInbox.fileName("", type: "public.data", number: 1), "Shared 1")
        let long = String(repeating: "a", count: 150) + ".png"
        XCTAssertEqual(CaptureInbox.fileName(long, type: "", number: 1).count, 104)
    }

    func testOffersTheVaultsTheLastOpenedFirst() throws {
        XCTAssertEqual(OfferedVaults.read(from: temporary), OfferedVaults(vaults: [], last: nil))
        let offered = OfferedVaults(
            vaults: [OfferedVault(id: "a", name: "Work"), OfferedVault(id: "b", name: "Home")],
            last: "b")
        try offered.write(to: temporary)
        let read = OfferedVaults.read(from: temporary)
        XCTAssertEqual(read, offered)
        XCTAssertEqual(read.ordered.map(\.name), ["Home", "Work"])
    }
}
