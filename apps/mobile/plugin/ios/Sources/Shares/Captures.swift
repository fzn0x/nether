// What iOS's share sheet hands Nether (ADR 0087), between the share
// extension and the app: the App Group they share holds an inbox, each
// capture a folder named by its ID with `capture.json` and a copy of each
// file shared, and the vaults the extension may offer, which the app
// writes. A capture is made in a folder with `.part` after its name, then
// renamed, so the app never reads half of one. Plain Foundation: the share
// extension compiles this file too, and the plugin's tests run it on the
// simulator.
import Foundation

/// The App Group the app and its share extension share: the one their
/// Info.plist names, as nether.xcconfig sets it, else the project's own.
public enum SharedGroup {
    public static let identifier: String = {
        let named = Bundle.main.object(forInfoDictionaryKey: "NetherAppGroup") as? String
        if let named, !named.isEmpty, !named.contains("$(") { return named }
        return "group.io.github.fzn0x.nether"
    }()

    /// The group's folder, or nil where the app is not signed into it.
    public static func folder() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }
}

/// A file of a capture: its name in the capture's folder, and its media type.
public struct CapturedFile: Codable, Equatable {
    public var name: String
    public var type: String

    public init(name: String, type: String) {
        self.name = name
        self.type = type
    }
}

/// A capture the share extension kept, as `capture.json` holds it.
public struct Capture: Codable, Equatable {
    public var id: String
    /// When it was shared, in milliseconds since 1970.
    public var at: Int64
    public var text: String
    public var title: String?
    public var url: String?
    /// The vault the extension's sheet chose, by its ID.
    public var vault: String?
    /// A vault for the app to make, by its name, when the phone had none.
    public var newVault: String?
    public var files: [CapturedFile]
}

/// A file to keep with a capture: its name and type, and where to copy it from.
public struct IncomingFile {
    public var name: String
    public var type: String
    public var from: URL

    public init(name: String, type: String, from: URL) {
        self.name = name
        self.type = type
        self.from = from
    }
}

public struct CaptureError: LocalizedError, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// The inbox in the App Group, which the extension writes and the app reads.
public final class CaptureInbox {
    public static let manifest = "capture.json"
    private static let part = ".part"
    /// The longest name a shared file keeps, before its extension.
    private static let longestName = 100

    public let root: URL

    public init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// The inbox of the App Group, or nil where the app is not signed into it.
    public static func shared() -> CaptureInbox? {
        SharedGroup.folder().map { CaptureInbox(root: $0.appendingPathComponent("Inbox", isDirectory: true)) }
    }

    /// Keeps a capture, with a copy of each file, all or nothing; gives what was kept.
    @discardableResult
    public func keep(
        text: String, title: String?, url: String?, vault: String?, newVault: String?,
        files: [IncomingFile], at: Date
    ) throws -> Capture {
        let id = UUID().uuidString.lowercased()
        let part = root.appendingPathComponent(id + CaptureInbox.part, isDirectory: true)
        let manager = FileManager.default
        try manager.createDirectory(at: part, withIntermediateDirectories: true)
        do {
            var taken: Set<String> = [CaptureInbox.manifest]
            var kept: [CapturedFile] = []
            for (index, file) in files.enumerated() {
                let name = CaptureInbox.freeName(
                    CaptureInbox.fileName(file.name, type: file.type, number: index + 1), taken: &taken)
                try manager.copyItem(at: file.from, to: part.appendingPathComponent(name))
                kept.append(CapturedFile(name: name, type: file.type))
            }
            let capture = Capture(
                id: id, at: Int64((at.timeIntervalSince1970 * 1000).rounded()), text: text,
                title: CaptureInbox.given(title), url: CaptureInbox.given(url),
                vault: CaptureInbox.given(vault), newVault: CaptureInbox.given(newVault), files: kept)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(capture).write(
                to: part.appendingPathComponent(CaptureInbox.manifest), options: .atomic)
            try manager.moveItem(at: part, to: root.appendingPathComponent(id, isDirectory: true))
            return capture
        } catch {
            try? manager.removeItem(at: part)
            throw error
        }
    }

    /// The captures kept, the oldest first, each with its folder; half-made ones are left out.
    public func pending() -> [(capture: Capture, folder: URL)] {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: root.path) else { return [] }
        var found: [(capture: Capture, folder: URL)] = []
        for name in names where !name.hasSuffix(CaptureInbox.part) && !name.hasPrefix(".") {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            guard let data = try? Data(contentsOf: folder.appendingPathComponent(CaptureInbox.manifest)),
                var capture = try? JSONDecoder().decode(Capture.self, from: data)
            else { continue }
            capture.id = name
            found.append((capture: capture, folder: folder))
        }
        return found.sorted { $0.capture.at < $1.capture.at }
    }

    /// Forgets a capture and its files.
    public func drop(_ id: String) throws {
        guard !id.isEmpty, !id.contains("/"), !id.hasPrefix(".") else {
            throw CaptureError("\"\(id)\" is not a capture of the inbox.")
        }
        let folder = root.appendingPathComponent(id, isDirectory: true)
        if FileManager.default.fileExists(atPath: folder.path) {
            try FileManager.default.removeItem(at: folder)
        }
    }

    /// Drops what a capture left half made, as when the extension was ended while it copied.
    public func sweep() {
        let manager = FileManager.default
        guard let names = try? manager.contentsOfDirectory(atPath: root.path) else { return }
        for name in names where name.hasSuffix(CaptureInbox.part) {
            try? manager.removeItem(at: root.appendingPathComponent(name))
        }
    }

    /// Whether a file is one the inbox keeps, so only those move into a vault.
    public func holds(_ path: String) -> Bool {
        let file = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        let inbox = root.resolvingSymlinksInPath().path
        return file.hasPrefix(inbox + "/")
    }

    private static func given(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    /// A shared file's name: its own, without what a file system or a link
    /// cannot hold, or "Shared" and its number, with an extension from its
    /// type when it has none.
    public static func fileName(_ name: String, type: String, number: Int) -> String {
        let forbidden = CharacterSet(charactersIn: "\\/:*?\"<>|#^[]").union(.controlCharacters)
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            scalars.append(forbidden.contains(scalar) ? "-" : scalar)
        }
        var clean = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = clean.first, first == "." || first.isWhitespace { clean.removeFirst() }
        if clean.isEmpty { clean = "Shared \(number)" + extensionOf(type) }
        let dot = clean.lastIndex(of: ".").flatMap { $0 == clean.startIndex ? nil : $0 }
        var stem = dot.map { String(clean[..<$0]) } ?? clean
        let ext = dot.map { String(clean[$0...]) } ?? ""
        if stem.count > longestName {
            stem = String(stem.prefix(longestName)).trimmingCharacters(in: .whitespaces)
        }
        return stem + ext
    }

    /// An extension for a media type or a uniform type: `.jpg` for `image/jpeg` or `public.jpeg`.
    public static func extensionOf(_ type: String) -> String {
        let lower = type.lowercased()
        let known: [String: String] = [
            "image/jpeg": ".jpg", "public.jpeg": ".jpg", "image/png": ".png", "public.png": ".png",
            "image/heic": ".heic", "public.heic": ".heic", "image/gif": ".gif",
            "com.compuserve.gif": ".gif", "application/pdf": ".pdf", "com.adobe.pdf": ".pdf",
            "text/plain": ".txt", "public.plain-text": ".txt", "public.mpeg-4": ".mp4",
            "video/mp4": ".mp4", "com.apple.quicktime-movie": ".mov", "video/quicktime": ".mov",
            "public.mp3": ".mp3", "audio/mpeg": ".mp3", "com.apple.m4a-audio": ".m4a",
        ]
        return known[lower] ?? ""
    }

    private static func freeName(_ name: String, taken: inout Set<String>) -> String {
        let dot = name.lastIndex(of: ".").flatMap { $0 == name.startIndex ? nil : $0 }
        let stem = dot.map { String(name[..<$0]) } ?? name
        let ext = dot.map { String(name[$0...]) } ?? ""
        var candidate = name
        var n = 1
        while taken.contains(candidate.lowercased()) {
            candidate = "\(stem) \(n)\(ext)"
            n += 1
        }
        taken.insert(candidate.lowercased())
        return candidate
    }
}

/// A vault the share extension may offer: its ID and name.
public struct OfferedVault: Codable, Equatable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// The vaults the app wrote to the App Group for the share extension, and the one opened last.
public struct OfferedVaults: Codable, Equatable {
    public var vaults: [OfferedVault]
    public var last: String?

    public init(vaults: [OfferedVault], last: String?) {
        self.vaults = vaults
        self.last = last
    }

    private static let name = "vaults.json"

    /// Writes the list into the group's folder, replacing the one there in one step.
    public func write(to group: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: group.appendingPathComponent(OfferedVaults.name), options: .atomic)
    }

    /// The list in the group's folder; none when the app has written none.
    public static func read(from group: URL) -> OfferedVaults {
        guard let data = try? Data(contentsOf: group.appendingPathComponent(name)),
            let offered = try? JSONDecoder().decode(OfferedVaults.self, from: data)
        else { return OfferedVaults(vaults: [], last: nil) }
        return offered
    }

    /// The vaults the extension offers, the one opened last first.
    public var ordered: [OfferedVault] {
        guard let last, let index = vaults.firstIndex(where: { $0.id == last }) else { return vaults }
        var list = vaults
        list.insert(list.remove(at: index), at: 0)
        return list
    }
}
