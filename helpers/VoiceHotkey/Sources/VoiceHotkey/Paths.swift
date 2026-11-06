import Foundation

/// Same locations as src/voiceOrders/paths.ts (override: VOICE_ORDERS_HOME).
enum Paths {
    static var root: URL {
        if let home = ProcessInfo.processInfo.environment["VOICE_ORDERS_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/wmbb-premiere-mcp/voice-orders")
    }
    static var token: URL { root.appendingPathComponent("token") }
    static var settings: URL { root.appendingPathComponent("settings.json") }
    /// Recordings land here; the daemon keeps the absolute path on the order.
    static var recordings: URL { root.appendingPathComponent("recordings") }

    static func readToken() -> String? {
        guard let s = try? String(contentsOf: token, encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// settings.json "hotkeyKeyCode" (default 105 = F13).
    static func hotkeyKeyCode() -> UInt16 {
        guard let d = try? Data(contentsOf: settings),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let k = j["hotkeyKeyCode"] as? NSNumber else { return 105 }
        return k.uint16Value
    }
}
