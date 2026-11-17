// A vault's folder on the phone (ADR 0087), on iOS: what needs the disk
// itself, as the desktop's Go service and the Android app's VaultFolder.java
// do it. It lists, reads with each file's SHA-256, and writes in one step: to
// a hidden temporary file beside the note, synced to the disk, renamed over
// it, after checking the note is still what the page last read. The page's
// DeviceFiles does the rest: the trash, free names, and the errors the
// vault's files give. Plain Foundation, so its tests need no app.
import CryptoKit
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// What a vault's folder fails with, in words the page can show.
public struct VaultError: LocalizedError, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// A file: its path in the vault, its size, when it last changed in
/// milliseconds, and the SHA-256 of its bytes, in hexadecimal, when it was read.
public struct FileInfo: Equatable {
    public let path: String
    public let size: Int64
    public let modified: Int64
    public let hash: String?
}

/// A file's text: missing when it is not there, binary when it is not UTF-8.
public struct FileText: Equatable {
    public let file: FileInfo
    public let text: String
    public let missing: Bool
    public let binary: Bool
}

/// A file's bytes.
public struct FileBytes: Equatable {
    public let file: FileInfo
    public let data: Data
}

/// What a write did: the file as written, or why it did not write.
public enum Written: Equatable {
    case written(FileInfo)
    case exists
    case changed
}

/// What a move did: the file where it went, or why it did not move.
public enum Moved: Equatable {
    case moved(FileInfo)
    case exists
    case missing
}

/// What a vault needs of the disk beyond Foundation: an atomic rename, and
/// syncing a folder.
public protocol Disk {
    /// Renames in one step, over a file that is there.
    func replace(_ from: String, with to: String) throws

    /// Flushes a folder's entries, so a rename survives a power cut.
    func syncFolder(_ folder: String)
}

/// The phone's own: rename(2), and F_FULLFSYNC, which reaches the disk itself
/// where fsync alone leaves the drive's cache.
public struct PhoneDisk: Disk {
    public init() {}

    public func replace(_ from: String, with to: String) throws {
        guard renameFile(from, to) else {
            throw VaultError("\(nameOf(to)) could not be replaced: \(lastError()).")
        }
    }

    public func syncFolder(_ folder: String) {
        // A folder the system will not sync is written with its next sync.
        syncPath(folder)
    }
}

public final class VaultFolder {
    public static let exists = "exists"
    public static let missing = "missing"

    /// The vault's folder, its links resolved.
    public let root: String
    private let disk: Disk
    /// One change at a time, so a write's check and its write see the same file.
    private let lock = NSRecursiveLock()

    public init(root: String, disk: Disk = PhoneDisk()) {
        self.root = realPath(root) ?? root
        self.disk = disk
    }

    /// The file at a path of the vault. It refuses paths that are not the
    /// vault's own: empty, absolute, with backslashes, or climbing out.
    public func resolve(_ path: String) throws -> String {
        let refused = VaultError("\"\(path)\" is not a path in the vault.")
        if path.isEmpty || path.hasPrefix("/") || path.contains("\\") || path.contains("\0") {
            throw refused
        }
        for part in path.split(separator: "/", omittingEmptySubsequences: false)
        where part.isEmpty || part == "." || part == ".." {
            throw refused
        }
        let file = root + "/" + path
        // A folder that is a link may not lead out of the vault.
        var parent = parentOf(file)
        while statOf(parent) == nil && parent != "/" {
            parent = parentOf(parent)
        }
        if let real = realPath(parent), real != root, !real.hasPrefix(root + "/") {
            throw VaultError("\"\(path)\" leads out of the vault.")
        }
        return file
    }

    private func folderAt(_ folder: String) throws -> String {
        try folder.isEmpty ? root : resolve(folder)
    }

    /// Every file below a folder, hidden ones below it left out; none when it is not a folder.
    public func walk(_ folder: String) throws -> [FileInfo] {
        let start = try folderAt(folder)
        var found: [FileInfo] = []
        if statOf(start)?.kind == .folder {
            filesIn(start, folder, &found)
        }
        return found
    }

    private func filesIn(_ folder: String, _ prefix: String, _ found: inout [FileInfo]) {
        for name in namesIn(folder) where !name.hasPrefix(".") {
            let child = folder + "/" + name
            let path = prefix.isEmpty ? name : prefix + "/" + name
            guard let info = statOf(child) else { continue }
            if info.kind == .folder {
                filesIn(child, path, &found)
            } else if info.kind == .file {
                found.append(FileInfo(path: path, size: info.size, modified: info.modified, hash: nil))
            }
        }
    }

    /// Every folder below a folder, hidden ones and what is in them left out.
    public func folders(_ folder: String) throws -> [String] {
        let start = try folderAt(folder)
        var found: [String] = []
        if statOf(start)?.kind == .folder {
            foldersIn(start, folder, &found)
        }
        return found
    }

    private func foldersIn(_ folder: String, _ prefix: String, _ found: inout [String]) {
        for name in namesIn(folder) where !name.hasPrefix(".") {
            let child = folder + "/" + name
            guard statOf(child)?.kind == .folder else { continue }
            let path = prefix.isEmpty ? name : prefix + "/" + name
            found.append(path)
            foldersIn(child, path, &found)
        }
    }

    /// The files that are there, of those asked, in order.
    public func stat(_ paths: [String]) throws -> [FileInfo] {
        var found: [FileInfo] = []
        for path in paths {
            let file = try resolve(path)
            if let info = statOf(file), info.kind == .file {
                found.append(FileInfo(path: path, size: info.size, modified: info.modified, hash: nil))
            }
        }
        return found
    }

    /// Files' text and hashes, in order, as the vault's files read them.
    public func readText(_ paths: [String]) throws -> [FileText] {
        var found: [FileText] = []
        for path in paths {
            let file = try resolve(path)
            guard let info = statOf(file), info.kind == .file else {
                let none = FileInfo(path: path, size: 0, modified: 0, hash: "")
                found.append(FileText(file: none, text: "", missing: true, binary: false))
                continue
            }
            let data = try readData(file)
            let read = FileInfo(
                path: path, size: Int64(data.count), modified: info.modified, hash: VaultFolder.sha256(data))
            if let text = VaultFolder.utf8(data) {
                found.append(FileText(file: read, text: text, missing: false, binary: false))
            } else {
                found.append(FileText(file: read, text: "", missing: false, binary: true))
            }
        }
        return found
    }

    /// A file's bytes and hash; nil when it is not there.
    public func readBytes(_ path: String) throws -> FileBytes? {
        let file = try resolve(path)
        guard let info = statOf(file), info.kind == .file else { return nil }
        let data = try readData(file)
        let read = FileInfo(
            path: path, size: Int64(data.count), modified: info.modified, hash: VaultFolder.sha256(data))
        return FileBytes(file: read, data: data)
    }

    /// Writes a file in one step, making its folders, if it is still `base`:
    /// the hash of its bytes last read, or "" for a file that must not be there.
    public func write(_ path: String, _ data: Data, base: String) throws -> Written {
        lock.lock()
        defer { lock.unlock() }
        let file = try resolve(path)
        let there = statOf(file)
        if base.isEmpty && there != nil { return .exists }
        if !base.isEmpty {
            guard there?.kind == .file else { return .changed }
            let current = try readData(file)
            if VaultFolder.sha256(current) != base { return .changed }
        }
        try makeFolders(parentOf(file), for: path)
        try VaultFolder.replaceFile(at: file, with: data, disk: disk)
        let modified = statOf(file)?.modified ?? 0
        return .written(
            FileInfo(path: path, size: Int64(data.count), modified: modified, hash: VaultFolder.sha256(data)))
    }

    /// Moves a file, making the folders it needs: missing when none is at
    /// `from`, else exists when anything is at `to`.
    public func move(_ from: String, to: String) throws -> Moved {
        lock.lock()
        defer { lock.unlock() }
        let source = try resolve(from)
        let target = try resolve(to)
        guard statOf(source)?.kind == .file else { return .missing }
        if statOf(target) != nil && realPath(source) != realPath(target) { return .exists }
        try makeFolders(parentOf(target), for: to)
        try disk.replace(source, with: target)
        disk.syncFolder(parentOf(target))
        disk.syncFolder(parentOf(source))
        let info = statOf(target)
        return .moved(FileInfo(path: to, size: info?.size ?? 0, modified: info?.modified ?? 0, hash: nil))
    }

    /// Deletes a file, and nothing else; false when none is there.
    public func delete(_ path: String) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let file = try resolve(path)
        guard statOf(file)?.kind == .file else { return false }
        guard removeFile(file) else { throw VaultError("\(path) could not be deleted: \(lastError()).") }
        disk.syncFolder(parentOf(file))
        return true
    }

    /// Makes a folder and those it is in: "exists" when a file or folder is there.
    public func makeFolder(_ path: String) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let folder = try resolve(path)
        if statOf(folder) != nil { return VaultFolder.exists }
        do {
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        } catch {
            throw VaultError("\(path): the folder could not be made.")
        }
        return "made"
    }

    /// Deletes an empty folder: "missing" when there is none, "full" when anything is in it.
    public func removeFolder(_ path: String) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let folder = try resolve(path)
        guard statOf(folder)?.kind == .folder else { return VaultFolder.missing }
        if !namesIn(folder).isEmpty { return "full" }
        guard removeEmptyFolder(folder) else {
            throw VaultError("\(path): the folder could not be removed: \(lastError()).")
        }
        return "removed"
    }

    /// The vault's ID, from its `.nether/vault.json`, as the desktop app keeps
    /// it there, so a vault copied from one to the other keeps its ID; written
    /// the first time.
    public func id() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let file = root + "/.nether/vault.json"
        var base = ""
        if statOf(file)?.kind == .file {
            let data = try readData(file)
            base = VaultFolder.sha256(data)
            if let kept = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let id = kept["id"] as? String, VaultFolder.isUUID(id)
            {
                return id
            }
        }
        let id = VaultFolder.uuidV7(Int64(Date().timeIntervalSince1970 * 1000))
        let json = "{\n  \"id\": \"\(id)\",\n  \"format\": 1\n}\n"
        guard case .written = try write(".nether/vault.json", Data(json.utf8), base: base) else {
            throw VaultError("The vault's ID could not be kept.")
        }
        return id
    }

    private func makeFolders(_ folder: String, for path: String) throws {
        if statOf(folder)?.kind == .folder { return }
        do {
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        } catch {
            throw VaultError("\(path): its folder could not be made.")
        }
    }

    /// Puts bytes at a file in one step: to a hidden temporary file beside
    /// it, synced to the disk, renamed over it, and the folder synced. A file
    /// cut short at any step holds the old bytes or the new, never part of either.
    public static func replaceFile(at file: String, with data: Data, disk: Disk) throws {
        let temporary = try writeTemporary(beside: file, data)
        do {
            try disk.replace(temporary, with: file)
        } catch {
            _ = removeFile(temporary)
            throw error
        }
        disk.syncFolder(parentOf(file))
    }

    /// The folder a vault of that name is kept in: the name, without what a
    /// path or a hidden name would read in it; "Notes" when nothing is left.
    public static func folderName(_ name: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            let reads = "\\/:*?\"<>|".unicodeScalars.contains(scalar) || scalar.value < 0x20 || scalar.value == 0x7F
            scalars.append(reads ? "-" : scalar)
        }
        var cleaned = trim(String(scalars))
        while cleaned.hasPrefix(".") {
            cleaned = trim(String(cleaned.dropFirst()))
        }
        if cleaned.count > 100 {
            cleaned = trim(String(cleaned.prefix(100)))
        }
        return cleaned.isEmpty ? "Notes" : cleaned
    }

    /// Text without spaces and control characters at either end, as Java's trim leaves it.
    public static func trim(_ text: String) -> String {
        let scalars = text.unicodeScalars
        guard let first = scalars.firstIndex(where: { $0.value > 0x20 }),
            let last = scalars.lastIndex(where: { $0.value > 0x20 })
        else {
            return ""
        }
        return String(scalars[first...last])
    }

    /// A UUID version 7 (RFC 9562), as the TypeScript core and the Go service make them.
    public static func uuidV7(_ millis: Int64) -> String {
        var bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max) }
        for index in 0..<6 {
            bytes[index] = UInt8(truncatingIfNeeded: millis >> (40 - 8 * index))
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x70
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        var uuid = ""
        for (index, digit) in hex(bytes).enumerated() {
            if index == 8 || index == 12 || index == 16 || index == 20 { uuid.append("-") }
            uuid.append(digit)
        }
        return uuid
    }

    /// Whether the text is a UUID in lowercase, as vaults keep their IDs.
    public static func isUUID(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count == 36 else { return false }
        for (index, scalar) in scalars.enumerated() {
            if index == 8 || index == 13 || index == 18 || index == 23 {
                if scalar != "-" { return false }
            } else if !(("0"..."9").contains(scalar) || ("a"..."f").contains(scalar)) {
                return false
            }
        }
        return true
    }

    /// UTF-8 text, a byte order mark kept; nil when the bytes are not UTF-8.
    public static func utf8(_ data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        // Decoding puts U+FFFD in place of bytes that are not UTF-8.
        return text.utf8.elementsEqual(data) ? text : nil
    }

    public static func sha256(_ data: Data) -> String {
        hex(SHA256.hash(data: data))
    }

    static func hex<Bytes: Sequence>(_ bytes: Bytes) -> String where Bytes.Element == UInt8 {
        let digits = Array("0123456789abcdef".utf8)
        var out: [UInt8] = []
        for byte in bytes {
            out.append(digits[Int(byte >> 4)])
            out.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}

// The system's calls, outside the class, whose methods share their names.

enum Kind {
    case file
    case folder
    case other
}

struct Status {
    let kind: Kind
    let size: Int64
    let modified: Int64
}

/// What is at a path, through links; nil when nothing is.
func statOf(_ path: String) -> Status? {
    var info = stat()
    guard stat(path, &info) == 0 else { return nil }
    let type = UInt32(info.st_mode) & 0o170000
    let kind: Kind = type == 0o040000 ? .folder : type == 0o100000 ? .file : .other
    #if canImport(Darwin)
    let time = info.st_mtimespec
    #else
    let time = info.st_mtim
    #endif
    let modified = Int64(time.tv_sec) * 1000 + Int64(time.tv_nsec) / 1_000_000
    return Status(kind: kind, size: Int64(info.st_size), modified: modified)
}

/// A folder's entries, by name, so lists come in the same order each time.
func namesIn(_ folder: String) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).sorted()
}

func readData(_ file: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: file))
}

func realPath(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

func parentOf(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "." }
    return slash == path.startIndex ? "/" : String(path[..<slash])
}

func nameOf(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
}

func lastError() -> String {
    String(cString: strerror(errno))
}

func renameFile(_ from: String, _ to: String) -> Bool {
    rename(from, to) == 0
}

func removeFile(_ file: String) -> Bool {
    unlink(file) == 0
}

func removeEmptyFolder(_ folder: String) -> Bool {
    rmdir(folder) == 0
}

/// Syncs what is open to the disk itself: F_FULLFSYNC on Apple's systems,
/// fsync where there is none, or where the file system will not.
func fullSync(_ descriptor: Int32) -> Bool {
    #if canImport(Darwin)
    if fcntl(descriptor, F_FULLFSYNC) == 0 { return true }
    #endif
    return fsync(descriptor) == 0
}

/// Syncs a file or folder by its path, as far as the system lets it.
func syncPath(_ path: String) {
    let descriptor = open(path, O_RDONLY)
    guard descriptor >= 0 else { return }
    _ = fullSync(descriptor)
    close(descriptor)
}

/// Writes bytes to a new hidden file beside `file`, synced to the disk, and gives its path.
func writeTemporary(beside file: String, _ data: Data) throws -> String {
    let folder = parentOf(file)
    let name = nameOf(file)
    for _ in 0..<100 {
        let suffix = VaultFolder.hex((0..<8).map { _ in UInt8.random(in: .min ... .max) })
        let temporary = folder + "/." + name + "." + suffix + ".tmp"
        let descriptor = open(temporary, O_WRONLY | O_CREAT | O_EXCL, mode_t(0o644))
        if descriptor < 0 {
            if errno == EEXIST { continue }
            throw VaultError("\(name) could not be written: \(lastError()).")
        }
        let wroteAll = data.withUnsafeBytes { buffer -> Bool in
            guard var pointer = buffer.baseAddress else { return true }
            var left = buffer.count
            while left > 0 {
                let count = write(descriptor, pointer, left)
                if count < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                pointer += count
                left -= count
            }
            return true
        }
        var failure: String?
        if !wroteAll || !fullSync(descriptor) { failure = lastError() }
        if close(descriptor) != 0 && failure == nil { failure = lastError() }
        if let failure {
            _ = removeFile(temporary)
            throw VaultError("\(name) could not be written: \(failure).")
        }
        return temporary
    }
    throw VaultError("\(name) could not be written: no free name for its temporary file.")
}
