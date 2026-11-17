// swift-tools-version: 5.9
// The mobile apps' own Capacitor plugin on iOS (ADR 0087): `Vaults`, a
// vault's folder on the phone in plain Foundation, with its tests.
import PackageDescription

let package = Package(
    name: "NetherMobilePlugin",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "NetherMobilePlugin",
            targets: ["Vaults"])
    ],
    targets: [
        .target(
            name: "Vaults",
            path: "ios/Sources/Vaults"),
        .testTarget(
            name: "VaultsTests",
            dependencies: ["Vaults"],
            path: "ios/Tests/VaultsTests")
    ]
)
