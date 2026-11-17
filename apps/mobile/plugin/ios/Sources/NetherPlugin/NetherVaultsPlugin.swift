// The mobile apps' own plugin on iOS (ADR 0087), which the page reaches as
// `NetherVaults` (apps/desktop/src/mobile.ts), as the Android app's
// NetherVaultsPlugin.java. It keeps the list of the phone's vaults, each a
// folder in the app's Documents, which the Files app shows under On My
// iPhone, Nether, and does to a vault's folder what needs the disk, through
// `VaultFolder`, one call at a time on a queue of its own. It keeps the list
// of the servers signed in to, without their tokens, which the page keeps in
// the Keychain, and opens a provider's sign-in in the system's sheet, which
// takes the app's scheme back itself. It moves a capture's files in from the
// App Group's inbox (NetherInboxPlugin), writes the vaults' names there for
// the share extension to offer, and writes exports for the share sheet in
// the app's caches, a ZIP from the vault's own files through `ZipExport`.
import AuthenticationServices
import Capacitor
import Foundation
import Shares
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
        CAPPluginMethod(name: "mark", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "servers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adopt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportAdd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFinish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportCancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportText", returnType: CAPPluginReturnPromise)
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
        offer(vaults, last: last)
    }

    /// Writes the vaults' IDs and names to the App Group, for the share extension's sheet to offer.
    private func offer(_ vaults: [[String: String]], last: String?) {
        guard let group = SharedGroup.folder() else { return }
        let offered = vaults.compactMap { entry -> OfferedVault? in
            guard let id = entry["id"], let name = entry["name"] else { return nil }
            return OfferedVault(id: id, name: name)
        }
        try? OfferedVaults(vaults: offered, last: last).write(to: group)
    }

    override public func load() {
        // The list as it was before the share extension came, for it to offer.
        queue.async { [self] in
            if let registry = try? readRegistry() { offer(registry.vaults, last: registry.last) }
        }
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
        let fresh = call.getBool("fresh", false)
        onDisk(call) { [self] in
            let registry = try readRegistry()
            let known = id.flatMap { id in registry.vaults.first { $0["id"] == id } }
            if let id, known == nil { throw VaultError("No vault \(id) is on this phone.") }
            var shown = known?["name"] ?? VaultFolder.trim(name ?? "")
            var folderName = known?["folder"] ?? VaultFolder.folderName(shown)
            // A fresh vault, as a workspace opened on the phone, never takes a folder that is there.
            if known == nil && fresh {
                let base = folderName
                let named = shown.isEmpty ? base : shown
                var n = 2
                while FileManager.default.fileExists(atPath: vaultsFolder.appendingPathComponent(folderName).path) {
                    folderName = "\(base) \(n)"
                    shown = "\(named) \(n)"
                    n += 1
                }
            }
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

    // The servers signed in to, beside the list of vaults: their accounts,
    // without their tokens, which the page keeps in the Keychain.

    private var serversFile: String {
        supportFolder.appendingPathComponent("servers.json").path
    }

    private func readServers() throws -> [[String: Any]] {
        let file = serversFile
        guard FileManager.default.fileExists(atPath: file) else { return [] }
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        guard let kept = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw VaultError("The list of servers could not be read.")
        }
        return kept["servers"] as? [[String: Any]] ?? []
    }

    /// The list without the server at an address, and with `first` at its head, if given.
    private func saveServers(first: [String: Any]?, without url: String) throws {
        try FileManager.default.createDirectory(at: supportFolder, withIntermediateDirectories: true)
        let others = try readServers().filter { ($0["url"] as? String) != url }
        let servers = (first.map { [$0] } ?? []) + others
        let data = try JSONSerialization.data(
            withJSONObject: ["servers": servers], options: [.prettyPrinted, .sortedKeys])
        try VaultFolder.replaceFile(at: serversFile, with: data, disk: disk)
    }

    @objc func servers(_ call: CAPPluginCall) {
        onDisk(call) { [self] in
            try ["servers": readServers()]
        }
    }

    @objc func saveServer(_ call: CAPPluginCall) {
        let account = call.getObject("account").map { $0 as [String: Any] }
        onDisk(call) { [self] in
            guard let account, let url = account["url"] as? String, !url.isEmpty else {
                throw VaultError("A server's account needs its address.")
            }
            try saveServers(first: account, without: url)
            return nil
        }
    }

    @objc func forgetServer(_ call: CAPPluginCall) {
        let url = call.getString("url", "")
        onDisk(call) { [self] in
            try saveServers(first: nil, without: url)
            return nil
        }
    }

    // A provider's sign-in (ADR 0087).

    /// The sign-in sheet open now, kept until it ends.
    private var signingIn: ASWebAuthenticationSession?

    /// Opens a provider's sign-in in the system's sheet, which takes the app's
    /// scheme back itself, so no other app can; answers with the address it
    /// came back to, or with none when the person cancelled it.
    @objc func signIn(_ call: CAPPluginCall) {
        guard let address = call.getString("url").flatMap({ URL(string: $0) }),
            let scheme = call.getString("scheme")
        else {
            call.reject("A sign-in needs its address and the app's scheme.")
            return
        }
        DispatchQueue.main.async { [self] in
            let session = ASWebAuthenticationSession(url: address, callbackURLScheme: scheme) {
                [weak self] url, error in
                self?.signingIn = nil
                if let url {
                    call.resolve(["url": url.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError,
                    error.code == .canceledLogin
                {
                    call.resolve()
                } else {
                    call.reject(error?.localizedDescription ?? "The sign-in sheet failed.", nil, error)
                }
            }
            session.presentationContextProvider = self
            signingIn = session
            if !session.start() {
                signingIn = nil
                call.reject("The sign-in sheet could not open.")
            }
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

    /// Moves a file the App Group's inbox keeps for a capture into the vault at
    /// a path, unless a file is there, so a shared photo never crosses the
    /// bridge. Only the inbox's files move in.
    @objc func adopt(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        let path = call.getString("path", "")
        let from = call.getString("from", "")
        onDisk(call) { [self] in
            guard let inbox = CaptureInbox.shared(), inbox.holds(from),
                FileManager.default.fileExists(atPath: from)
            else { throw VaultError("\"\(from)\" is not a file the app keeps for a capture.") }
            let data = try Data(contentsOf: URL(fileURLWithPath: from))
            switch try folderOf(id).write(path, data, base: "") {
            case .written(let file):
                return ["result": "written", "file": NetherVaultsPlugin.infoOf(file)]
            case .exists:
                return ["result": "exists"]
            case .changed:
                return ["result": "changed"]
            }
        }
    }

    // Exports, in the app's caches, for the share sheet (mobileExports.ts).

    private var exports: [String: ZipExport] = [:]
    private var exportsSwept = false

    /// A new folder in the exports' folder, which holds only this run's: older ones are gone.
    private func exportFolder() throws -> URL {
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("exports", isDirectory: true)
        if !exportsSwept {
            try? FileManager.default.removeItem(at: root)
            exportsSwept = true
        }
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// A file's name for the share sheet, without what a file system cannot hold.
    private static func exportName(_ name: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        let clean = name.components(separatedBy: forbidden).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty || clean.hasPrefix(".") ? "Nether" + clean : clean
    }

    @objc func exportStart(_ call: CAPPluginCall) {
        let name = call.getString("name", "")
        onDisk(call) { [self] in
            let token = UUID().uuidString
            let file = try exportFolder().appendingPathComponent(NetherVaultsPlugin.exportName(name) + ".zip")
            exports[token] = try ZipExport(file: file)
            return ["token": token]
        }
    }

    @objc func exportAdd(_ call: CAPPluginCall) {
        let token = call.getString("token", "")
        let id = call.getString("id", "")
        let entries = call.getArray("entries", JSObject.self) ?? []
        onDisk(call) { [self] in
            guard let zip = exports[token] else { throw VaultError("No export is open as \(token).") }
            for entry in entries {
                let path = entry["path"] as? String ?? ""
                if let source = entry["source"] as? String {
                    let file = try folderOf(id).resolve(source)
                    try zip.addFile(path, from: URL(fileURLWithPath: file))
                } else {
                    try zip.addText(path, entry["text"] as? String ?? "")
                }
            }
            return nil
        }
    }

    @objc func exportFinish(_ call: CAPPluginCall) {
        let token = call.getString("token", "")
        onDisk(call) { [self] in
            // Let go, the archive closes its file, complete.
            guard let zip = exports.removeValue(forKey: token) else {
                throw VaultError("No export is open as \(token).")
            }
            return ["path": zip.file.path]
        }
    }

    @objc func exportCancel(_ call: CAPPluginCall) {
        let token = call.getString("token", "")
        onDisk(call) { [self] in
            exports.removeValue(forKey: token)?.cancel()
            return nil
        }
    }

    /// Writes a text the page made, a database's CSV or a note's copy, as a file for the share sheet.
    @objc func exportText(_ call: CAPPluginCall) {
        let name = call.getString("name", "")
        let text = call.getString("text", "")
        onDisk(call) { [self] in
            let file = try exportFolder().appendingPathComponent(NetherVaultsPlugin.exportName(name))
            try Data(text.utf8).write(to: file, options: .atomic)
            return ["path": file.path]
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

extension NetherVaultsPlugin: ASWebAuthenticationPresentationContextProviding {
    /// The sign-in sheet shows over the app's own window.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
