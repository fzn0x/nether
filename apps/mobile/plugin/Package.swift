// swift-tools-version: 5.9
// The mobile apps' own Capacitor plugin on iOS (ADR 0087): `Vaults`, a
// vault's folder on the phone in plain Foundation, with its tests; `Shares`,
// the share extension's inbox in the App Group, which the extension compiles
// too, and exports' ZIPs, with their tests; and `NetherPlugin`, the plugins
// the page reaches as `NetherVaults` and `NetherInbox`. Capacitor's CLI finds
// it in apps/mobile's dependencies and adds it to the app's packages, as it
// does each plugin from npm.
import PackageDescription

let package = Package(
    name: "NetherMobilePlugin",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "NetherMobilePlugin",
            targets: ["NetherPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // The app has it already, through the SQLite plugin; the plugin names it itself.
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.20")
    ],
    targets: [
        .target(
            name: "Vaults",
            path: "ios/Sources/Vaults"),
        .target(
            name: "Shares",
            dependencies: [
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/Shares"),
        .target(
            name: "NetherPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "Vaults",
                "Shares"
            ],
            path: "ios/Sources/NetherPlugin"),
        .testTarget(
            name: "VaultsTests",
            dependencies: ["Vaults"],
            path: "ios/Tests/VaultsTests"),
        .testTarget(
            name: "SharesTests",
            dependencies: ["Shares"],
            path: "ios/Tests/SharesTests")
    ]
)
