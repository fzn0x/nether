// What iOS's share sheet hands Nether (ADR 0087), which the page reaches as
// `NetherInbox` (apps/desktop/src/mobile.ts): the captures the share
// extension kept in the App Group's inbox, read as the app opens or comes
// back, and dropped once the page filed them.
import Capacitor
import Foundation
import Shares

@objc(NetherInboxPlugin)
public class NetherInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NetherInboxPlugin"
    public let jsName = "NetherInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drop", returnType: CAPPluginReturnPromise),
    ]

    /// One call at a time, beside the extension, which only adds.
    private let queue = DispatchQueue(label: "io.github.fzn0x.nether.inbox")

    override public func load() {
        queue.async {
            CaptureInbox.shared()?.sweep()
        }
    }

    @objc func pending(_ call: CAPPluginCall) {
        queue.async {
            let captures = (CaptureInbox.shared()?.pending() ?? []).map { kept -> [String: Any] in
                let capture = kept.capture
                var answer: [String: Any] = [
                    "id": capture.id,
                    "at": Int(capture.at),
                    "text": capture.text,
                    "files": capture.files.map { file -> [String: Any] in
                        [
                            "name": file.name,
                            "type": file.type,
                            "path": kept.folder.appendingPathComponent(file.name).path,
                        ]
                    },
                ]
                if let title = capture.title { answer["title"] = title }
                if let url = capture.url { answer["url"] = url }
                if let vault = capture.vault { answer["vault"] = vault }
                if let newVault = capture.newVault { answer["newVault"] = newVault }
                return answer
            }
            call.resolve(["captures": captures])
        }
    }

    @objc func drop(_ call: CAPPluginCall) {
        let id = call.getString("id", "")
        queue.async {
            do {
                try CaptureInbox.shared()?.drop(id)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }
}
