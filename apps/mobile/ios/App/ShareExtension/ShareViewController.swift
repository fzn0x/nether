// Nether's share extension on iOS (ADR 0087): a small native sheet in other
// apps' share sheets, showing what is shared, the vault it goes to, and
// Save. It loads no WebView, as an extension has little memory. Save keeps
// the capture, with a copy of each file, in the inbox of the App Group the
// app shares (Captures.swift, which the app's plugin reads), and the app
// files it as a note in the vault's capture folder as it opens or comes
// back. The vaults it offers are those the app wrote to the group.
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A string of the extension's own, translated in its Localizable.strings.
private func local(_ key: String, _ english: String) -> String {
    NSLocalizedString(key, tableName: nil, bundle: .main, value: english, comment: "")
}

/// What is being shared, as the sheet shows and edits it.
final class ShareModel: ObservableObject {
    @Published var text = ""
    @Published var title: String?
    @Published var url: String?
    @Published var files: [IncomingFile] = []
    @Published var loading = true
    @Published var vaults: [OfferedVault] = []
    @Published var chosen = ""
    @Published var newVault = local("vault.default", "Notes")
    @Published var failure: String?

    private weak var context: NSExtensionContext?
    /// Where shared files wait, copied, until Save keeps them in the inbox.
    private let staging = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)

    init(context: NSExtensionContext?) {
        self.context = context
    }

    /// Reads the vaults the app offers, and what the other app shares.
    func load() {
        if let group = SharedGroup.folder() {
            vaults = OfferedVaults.read(from: group).ordered
            chosen = vaults.first?.id ?? ""
        }
        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let items = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        let waiting = DispatchGroup()
        var contentText: String?
        for item in items {
            if contentText == nil, let given = item.attributedContentText?.string, !given.isEmpty {
                contentText = given
            }
            if title == nil, let given = item.attributedTitle?.string, !given.isEmpty { title = given }
            for provider in item.attachments ?? [] { read(provider, waiting) }
        }
        waiting.notify(queue: .main) { [self] in
            // Safari gives the page's title as the item's text, beside its address.
            if let given = contentText {
                if url != nil {
                    if title == nil, given != url { title = given }
                } else if text.isEmpty {
                    text = given
                }
            }
            loading = false
        }
    }

    private func read(_ provider: NSItemProvider, _ waiting: DispatchGroup) {
        let fileTypes: [UTType] = [.image, .pdf, .movie, .audio]
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
            !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            waiting.enter()
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [self] item, _ in
                DispatchQueue.main.async { [self] in
                    if let link = item as? URL, url == nil { url = link.absoluteString }
                    waiting.leave()
                }
            }
        } else if let type = fileTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) })
            ?? (provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) ? .item : nil) {
            let identifier = provider.registeredTypeIdentifiers.first {
                UTType($0)?.conforms(to: type) ?? false
            } ?? type.identifier
            waiting.enter()
            provider.loadFileRepresentation(forTypeIdentifier: identifier) { [self] file, _ in
                // The file is the system's only until this returns: it is copied now.
                let kept = file.flatMap { file -> IncomingFile? in
                    let base = provider.suggestedName ?? file.deletingPathExtension().lastPathComponent
                    let ext = file.pathExtension
                    let named = (base as NSString).pathExtension.lowercased() == ext.lowercased()
                    let name = ext.isEmpty || named ? base : "\(base).\(ext)"
                    let copy = staging.appendingPathComponent(UUID().uuidString)
                    guard (try? FileManager.default.copyItem(at: file, to: copy)) != nil else { return nil }
                    return IncomingFile(name: name, type: identifier, from: copy)
                }
                DispatchQueue.main.async { [self] in
                    if let kept { files.append(kept) }
                    waiting.leave()
                }
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            waiting.enter()
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [self] item, _ in
                DispatchQueue.main.async { [self] in
                    if let shared = item as? String, !shared.isEmpty {
                        text = text.isEmpty ? shared : text + "\n\n" + shared
                    }
                    waiting.leave()
                }
            }
        }
    }

    /// Keeps the capture in the App Group's inbox, for the app to file.
    func save() {
        guard let inbox = CaptureInbox.shared() else {
            failure = local("error.group", "Nether cannot reach its inbox. Open Nether once, then share again.")
            return
        }
        do {
            try inbox.keep(
                text: text, title: title, url: url,
                vault: vaults.isEmpty ? nil : chosen,
                newVault: vaults.isEmpty ? newVault : nil,
                files: files, at: Date())
            try? FileManager.default.removeItem(at: staging)
            context?.completeRequest(returningItems: nil)
        } catch {
            failure = error.localizedDescription
        }
    }

    func cancel() {
        try? FileManager.default.removeItem(at: staging)
        context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
}

/// The sheet: what is shared, the vault it goes to, Cancel and Save.
struct ShareSheet: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                Section(local("note", "Note")) {
                    TextEditor(text: $model.text)
                        .frame(minHeight: 120)
                        .accessibilityLabel(local("note", "Note"))
                }
                if model.title != nil || model.url != nil {
                    Section(local("link", "Link")) {
                        if let title = model.title { Text(title) }
                        if let url = model.url { Text(url).foregroundColor(.secondary) }
                    }
                }
                if !model.files.isEmpty {
                    Section(local("files", "Files")) {
                        ForEach(model.files.indices, id: \.self) { index in
                            Text(model.files[index].name)
                        }
                    }
                }
                Section(local("vault", "Vault")) {
                    if model.vaults.isEmpty {
                        TextField(local("vault.new", "New vault"), text: $model.newVault)
                        Text(local("vault.new.hint", "This phone has no vault yet: Nether makes this one."))
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    } else {
                        Picker(local("vault", "Vault"), selection: $model.chosen) {
                            ForEach(model.vaults, id: \.id) { vault in
                                Text(vault.name).tag(vault.id)
                            }
                        }
                    }
                }
                if let failure = model.failure {
                    Text(failure).foregroundColor(.red)
                }
            }
            .navigationTitle(local("title", "Save to Nether"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(local("cancel", "Cancel")) { model.cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(local("save", "Save")) { model.save() }
                        .disabled(model.loading)
                }
            }
        }
    }
}

final class ShareViewController: UIViewController {
    private lazy var model = ShareModel(context: extensionContext)

    override func viewDidLoad() {
        super.viewDidLoad()
        let sheet = UIHostingController(rootView: ShareSheet(model: model))
        addChild(sheet)
        sheet.view.frame = view.bounds
        sheet.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(sheet.view)
        sheet.didMove(toParent: self)
        model.load()
    }
}
