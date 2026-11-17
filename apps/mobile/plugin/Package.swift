// swift-tools-version: 5.9
// The mobile apps' own Capacitor plugin on iOS (ADR 0087): `Vaults`, a
// vault's folder on the phone in plain Foundation, with its tests; and
// `NetherPlugin`, the plugin the page reaches as `NetherVaults`. Capacitor's
// CLI finds it in apps/mobile's dependencies and adds it to the app's
// packages, as it does each plugin from npm.
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
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "Vaults",
            path: "ios/Sources/Vaults"),
        .target(
            name: "NetherPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "Vaults"
            ],
            path: "ios/Sources/NetherPlugin"),
        .testTarget(
            name: "VaultsTests",
            dependencies: ["Vaults"],
            path: "ios/Tests/VaultsTests")
    ]
)
