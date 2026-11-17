import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// What the app shortcuts plugin (@capawesome/capacitor-app-shortcuts) listens
    /// for: a Home Screen quick action chosen, which it keeps until the page listens.
    private static let shortcutChosen = Notification.Name("handleAppShortcutNotification")

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        // A quick action that started the app, such as Capture (ADR 0087).
        if let shortcutItem = connectionOptions.shortcutItem {
            SceneDelegate.choose(shortcutItem)
        }
        #if DEBUG
        // The simulator's smoke test starts the app as a quick action would,
        // which simctl cannot choose: NETHER_SHORTCUT names the shortcut.
        if connectionOptions.shortcutItem == nil,
            let shortcut = ProcessInfo.processInfo.environment["NETHER_SHORTCUT"], !shortcut.isEmpty {
            SceneDelegate.choose(UIApplicationShortcutItem(type: shortcut, localizedTitle: shortcut))
        }
        #endif

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        SceneDelegate.choose(shortcutItem)
        completionHandler(true)
    }

    private static func choose(_ shortcutItem: UIApplicationShortcutItem) {
        NotificationCenter.default.post(name: shortcutChosen, object: nil, userInfo: ["shortcutItem": shortcutItem])
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
