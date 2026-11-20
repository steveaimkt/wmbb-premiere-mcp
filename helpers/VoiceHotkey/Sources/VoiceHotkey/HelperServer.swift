import Foundation
import Network

/// 127.0.0.1:47614 — POST /start, POST /stop for the panel's record button (proxied by the daemon).
/// Same gate as the daemon: token header must match the token file, Host must be loopback.
final class HelperServer {
    private let listener: NWListener
    private let onStart: () -> Void
    private let onStop: () -> Void

    init(port: UInt16 = 47614, onStart: @escaping () -> Void, onStop: @escaping () -> Void) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: params)
        self.onStart = onStart
        self.onStop = onStop
    }

    func start() {
        listener.newConnectionHandler = { [weak self] c in self?.handle(c) }
        listener.start(queue: .main)
    }

    private func handle(_ c: NWConnection) {
        c.start(queue: .main)
        c.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8) else { c.cancel(); return }
            let (status, body) = self.route(text)
            let resp = "HTTP/1.1 \(status)\r\ncontent-type: application/json\r\ncontent-length: \(body.utf8.count)\r\nconnection: close\r\n\r\n\(body)"
            c.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }

    private func route(_ raw: String) -> (String, String) {
        let lines = raw.components(separatedBy: "\r\n")
        let reqLine = lines.first?.split(separator: " ") ?? []
        guard reqLine.count >= 2 else { return ("400 Bad Request", #"{"success":false}"#) }
        var headers: [String: String] = [:]
        for l in lines.dropFirst() {
            guard let i = l.firstIndex(of: ":") else { continue }
            headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
        }
        let host = headers["host"] ?? ""
        guard host == "127.0.0.1:47614" || host == "localhost:47614" else { return ("403 Forbidden", #"{"success":false,"error":"host"}"#) }
        guard let token = Paths.readToken(), headers["x-voice-orders-token"] == token else { return ("401 Unauthorized", #"{"success":false,"error":"token"}"#) }
        switch (reqLine[0], reqLine[1]) {
        case ("POST", "/start"): onStart(); return ("200 OK", #"{"success":true}"#)
        case ("POST", "/stop"): onStop(); return ("200 OK", #"{"success":true}"#)
        default: return ("404 Not Found", #"{"success":false}"#)
        }
    }
}
