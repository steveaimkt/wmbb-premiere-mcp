// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VoiceHotkey",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "VoiceHotkey", path: "Sources/VoiceHotkey")
    ]
)
