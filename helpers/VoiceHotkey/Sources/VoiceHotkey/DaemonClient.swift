import Foundation

/// Talks to the voice-orders daemon on 127.0.0.1:47613 with the shared token.
struct DaemonClient {
    var base = URL(string: "http://127.0.0.1:47613")!

    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        if let t = Paths.readToken() { req.setValue(t, forHTTPHeaderField: "x-voice-orders-token") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard (200..<300).contains(code) else {
            throw NSError(domain: "Daemon", code: code, userInfo: [NSLocalizedDescriptionKey: "HTTP \(code) \(json["error"] ?? "")"])
        }
        return json
    }

    func keyDown() async throws -> String {
        let j = try await post("/hotkey/down")
        guard let id = j["pendingId"] as? String else { throw NSError(domain: "Daemon", code: 0, userInfo: [NSLocalizedDescriptionKey: "no pendingId"]) }
        return id
    }

    func keyUp(pendingId: String, wav: URL, durationSec: Double) async throws {
        _ = try await post("/hotkey/up", ["pendingId": pendingId, "wavPath": wav.path, "durationSec": durationSec])
    }
}
