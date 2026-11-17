// An export's ZIP on iOS (ADR 0087), as the Android app's ZipExportTest.java
// has it: the page's text and the vault's own files, by the paths the page
// gives, none climbing out.
import Foundation
import XCTest
import ZIPFoundation

@testable import Shares

final class ZipExportTests: XCTestCase {
    private var temporary = URL(fileURLWithPath: "/")

    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporary)
    }

    private func entry(_ archive: Archive, _ path: String) throws -> Data {
        let found = try XCTUnwrap(archive[path])
        var data = Data()
        _ = try archive.extract(found) { data.append($0) }
        return data
    }

    func testWritesTextAndFilesAsTheyAre() throws {
        let image = temporary.appendingPathComponent("photo.png")
        let bytes = Data([0x89, 0x50, 0x4E, 0x47, 0, 1, 2])
        try bytes.write(to: image)
        let file = temporary.appendingPathComponent("out/Vault.zip")
        do {
            let zip = try ZipExport(file: file)
            try zip.addText("Notes/Ideas.md", "# Ideas\n\nü\n")
            try zip.addFile("attachments/photo.png", from: image)
        }
        let archive = try Archive(url: file, accessMode: .read)
        XCTAssertEqual(archive.map(\.path), ["Notes/Ideas.md", "attachments/photo.png"])
        XCTAssertEqual(try entry(archive, "Notes/Ideas.md"), Data("# Ideas\n\nü\n".utf8))
        XCTAssertEqual(try entry(archive, "attachments/photo.png"), bytes)
    }

    func testRefusesPathsOutOfTheExportAndTwiceTheSame() throws {
        let zip = try ZipExport(file: temporary.appendingPathComponent("Vault.zip"))
        for path in ["", "/etc/passwd", "../up.md", "a//b.md", "a\\b.md", "./a.md"] {
            XCTAssertThrowsError(try zip.addText(path, "x"), path)
        }
        try zip.addText("a.md", "x")
        XCTAssertThrowsError(try zip.addText("a.md", "y"))
        zip.cancel()
        XCTAssertFalse(FileManager.default.fileExists(atPath: zip.file.path))
    }
}
