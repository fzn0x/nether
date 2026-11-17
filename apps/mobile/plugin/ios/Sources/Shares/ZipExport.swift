// An export's ZIP on iOS (ADR 0087), written in the app's caches from text
// the page made and from the vault's own files, as Go writes it on the
// desktop, with ZIPFoundation: the vault's files never cross the bridge.
// The share sheet then sends it on.
import Foundation
import ZIPFoundation

public final class ZipExport {
    public let file: URL
    private let archive: Archive
    private var names = Set<String>()

    public init(file: URL) throws {
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        self.file = file
        archive = try Archive(url: file, accessMode: .create)
    }

    /// A path in the ZIP, as the page names it: relative, separated by slashes, never climbing out.
    private func entryName(_ path: String) throws -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0"),
            !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
        else { throw CaptureError("\"\(path)\" is not a path for an export.") }
        guard names.insert(path).inserted else { throw CaptureError("\(path) is in the export twice.") }
        return path
    }

    /// Adds text the page made, as UTF-8.
    public func addText(_ path: String, _ text: String) throws {
        let data = Data(text.utf8)
        try archive.addEntry(
            with: entryName(path), type: .file, uncompressedSize: Int64(data.count),
            compressionMethod: .deflate
        ) { position, size in
            let start = Int(position)
            return data.subdata(in: start..<min(start + size, data.count))
        }
    }

    /// Adds a file of the vault, as it is on the disk.
    public func addFile(_ path: String, from source: URL) throws {
        try archive.addEntry(with: entryName(path), fileURL: source, compressionMethod: .deflate)
    }

    /// Drops the ZIP, unfinished.
    public func cancel() {
        try? FileManager.default.removeItem(at: file)
    }
}
