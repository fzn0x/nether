// The mobile apps' own plugin on iOS (ADR 0087), which the page reaches as
// `NetherVaults` (apps/desktop/src/mobile.ts), as the Android app's
// NetherVaultsPlugin.java. It keeps the list of the phone's vaults, each a
// folder in the app's Documents, which the Files app shows under On My
// iPhone, Nether, and does to a vault's folder what needs the disk, through
// `VaultFolder`, one call at a time on a queue of its own.
import Capacitor
import Foundation
import Vaults
import os

@objc(NetherVaultsPlugin)
public class NetherVaultsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NetherVaultsPlugin"
    public let jsName = "NetherVaults"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "vaults", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "root", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "walk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "folders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readBytes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "makeFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mark", returnType: CAPPluginReturnPromise)
    ]

    /// The points the page reaches, for the smoke test and tools/perf.
    private static let marks = Logger(subsystem: "io.github.fzn0x.nether", category: "NetherMarks")

    private let disk = PhoneDisk()
    /// One call at a time, so a write's check and its write see the same file.
    private let queue = DispatchQueue(label: "io.github.fzn0x.nether.vaults")
    private var opened: [String: VaultFolder] = [:]

    /// Runs a call's work on the queue, and answers it.
    private func onDisk(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]?) {
        queue.async {
            do {
                if let answer = try work() {
                    call.resolve(answer)
                } else {
                    call.resolve()
                }
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    // The list of vaults, in the app's support folder, out of the Files app's sight.

    private var supportFolder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// The app's Documents, which the Files app shows: each vault is a folder in it.
    private var vaultsFolder: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private var registryFile: String {
        supportFolder.appendingPathComponent("vaults.json").path
    }

    private func readRegistry() throws -> (vaults: [[String: String]], last: String?) {
        let file = registryFile
        guard FileManager.default.fileExists(atPath: file) else { return ([], nil) }
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        guard let kept = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw VaultError("The list of vaults could not be read.")
        }
        let vaults = (kept["vaults"] as? [[String: Any]] ?? []).compactMap { each -> [String: String]? in
            guard let id = each["id"] as? String, let name = each["name"] as? String,
                let folder = each["folder"] as? String
            else { return nil }
            return ["id": id, "name": name, "folder": folder]
        }
        return (vaults, kept["last"] as? String)
    }

    private func saveRegistry(_ vaults: [[String: String]], last: String?) throws {
        try FileManager.default.createDirectory(at: supportFolder, withIntermediateDirectories: true)
        var kept: [String: Any] = ["vaults": vaults]
        if let last { kept["last"] = last }
        let data = try JSONSerialization.data(withJSONObject: kept, options: [.prettyPrinted, .sortedKeys])
        try VaultFolder.replaceFile(at: registryFile, with: data, disk: disk)
    }

    private func folderOf(_ id: String) throws -> VaultFolder {
        if let found = opened[id] { return found }
        let registry = try readRegistry()
        guard let entry = registry.vaults.first(where: { $0["id"] == id }), let name = entry["folder"] else {
            throw VaultError("No vault \(id) is on this phone.")
        }
        let folder = VaultFolder(root: vaultsFolder.appendingPathComponent(name).path, disk: disk)
        opened[id] = folder
        return folder
    }

    private static func vaultOf(_ entry: [String: String]) -> [String: Any] {
        ["id": entry["id"] ?? "", "name": entry["name"] ?? "", "path": entry["folder"] ?? ""]
    }

    @objc func vaults(_ call: CAPPluginCall) {
        onDisk(call) { [self] in
            let registry = try readRegistry()
            var answer: [String: Any] = ["vaults": registry.vaults.map(NetherVaultsPlugin.vaultOf)]
            if let last = registry.last { answer["last"] = last }
            return answer
        }
    }

    @objc func openVault(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let name = call.getString("name")
        onDisk(call) { [self] in
            let registry = try readRegistry()
            let known = id.flatMap { id in registry.vaults.first { $0["id"] == id } }
            if let id, known == nil { throw VaultError("No vault \(id) is on this phone.") }
            let shown = known?["name"] ?? VaultFolder.trim(name ?? "")
            let folderName = known?["folder"] ?? VaultFolder.folderName(shown)
            let root = vaultsFolder.appendingPathComponent(folderName).path
            do {
                try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            } catch {
                throw VaultError("The vault's folder could not be made.")
            }
            let folder = VaultFolder(root: root, disk: disk)
            let vaultId = try folder.id()
            opened[vaultId] = folder
            let entry = ["id": vaultId, "name": shown.isEmpty ? folderName : shown, "folder": folderName]
            // The latest first, each vault and each folder once.
            let others = registry.vaults.filter { $0["id"] != vaultId && $0["folder"] != folderName }
            try saveRegistry([entry] + others, last: vaultId)
            return NetherVaultsPlugin.vaultOf(entry)
        }
    }

    @objc func forgetVault(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        onDisk(call) { [self] in
            let registry = try readRegistry()
            let last = registry.last == id ? nil : registry.last
            try saveRegistry(registry.vaults.filter { $0["id"] != id }, last: last)
            opened[id] = nil
            return nil
        }
    }

    @objc func root(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        onDisk(call) { [self] in
            try ["path": folderOf(id).root]
        }
    }

    // A vault's files.

    private static func infoOf(_ file: FileInfo) -> [String: Any] {
        var info: [String: Any] = ["path": file.path, "size": file.size, "modified": file.modified]
        if let hash = file.hash { info["hash"] = hash }
        return info
    }

    private static func pathsOf(_ call: CAPPluginCall) -> [String] {
        call.getArray("paths", String.self) ?? []
    }

    @objc func walk(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let folder = call.getString("folder", "")
        onDisk(call) { [self] in
            try ["files": folderOf(id).walk(folder).map(NetherVaultsPlugin.infoOf)]
        }
    }

    @objc func folders(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let folder = call.getString("folder", "")
        onDisk(call) { [self] in
            try ["folders": folderOf(id).folders(folder)]
        }
    }

    @objc func stat(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let paths = NetherVaultsPlugin.pathsOf(call)
        onDisk(call) { [self] in
            try ["files": folderOf(id).stat(paths).map(NetherVaultsPlugin.infoOf)]
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let paths = NetherVaultsPlugin.pathsOf(call)
        onDisk(call) { [self] in
            let files = try folderOf(id).readText(paths).map { text -> [String: Any] in
                var file = NetherVaultsPlugin.infoOf(text.file)
                file["text"] = text.text
                if text.missing { file["missing"] = true }
                if text.binary { file["binary"] = true }
                return file
            }
            return ["files": files]
        }
    }

    @objc func readBytes(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        onDisk(call) { [self] in
            guard let bytes = try folderOf(id).readBytes(path) else { return [:] }
            var file = NetherVaultsPlugin.infoOf(bytes.file)
            file["data"] = bytes.data.base64EncodedString()
            return ["file": file]
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        let base = call.getString("base", "")
        let text = call.getString("text")
        let data = call.getString("data")
        onDisk(call) { [self] in
            let bytes: Data
            if let text {
                bytes = Data(text.utf8)
            } else if let decoded = Data(base64Encoded: data ?? "") {
                bytes = decoded
            } else {
                throw VaultError("\(path): the bytes to write are not base64.")
            }
            switch try folderOf(id).write(path, bytes, base: base) {
            case .written(let file):
                return ["result": "written", "file": NetherVaultsPlugin.infoOf(file)]
            case .exists:
                return ["result": "exists"]
            case .changed:
                return ["result": "changed"]
            }
        }
    }

    @objc func move(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let from = call.getString("from", "")
        let to = call.getString("to", "")
        onDisk(call) { [self] in
            switch try folderOf(id).move(from, to: to) {
            case .moved(let file):
                return ["result": "moved", "file": NetherVaultsPlugin.infoOf(file)]
            case .exists:
                return ["result": "exists"]
            case .missing:
                return ["result": "missing"]
            }
        }
    }

    @objc func delete(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        onDisk(call) { [self] in
            try ["deleted": folderOf(id).delete(path)]
        }
    }

    @objc func makeFolder(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        onDisk(call) { [self] in
            try ["result": folderOf(id).makeFolder(path)]
        }
    }

    @objc func removeFolder(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        onDisk(call) { [self] in
            try ["result": folderOf(id).removeFolder(path)]
        }
    }

    /// Writes a point the page reached to the system's log, with the
    /// milliseconds since the app's process started, as Android's marks have it.
    @objc func mark(_ call: CAPPluginCall) {
        let name = call.getString("name", "")
        let since = NetherVaultsPlugin.sinceStart()
        NetherVaultsPlugin.marks.notice("NetherMarks: \(name, privacy: .public) \(since, privacy: .public)")
        call.resolve()
    }

    /// Milliseconds since the system started the app's process.
    private static func sinceStart() -> Int64 {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0 else { return -1 }
        let start = info.kp_proc.p_un.__p_starttime
        let started = Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
        return Int64((Date().timeIntervalSince1970 - started) * 1000)
    }
}
