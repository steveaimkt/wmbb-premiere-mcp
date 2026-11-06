import AppKit
import AVFoundation
import ApplicationServices

/// Menu-bar helper: hold the hotkey (default F13) → record → hand the WAV to the daemon.
/// ○ idle  ● recording  ⚠ daemon unreachable / permission missing
final class App: NSObject, NSApplicationDelegate {
    private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let recorder = Recorder()
    private let daemon = DaemonClient()
    private var keyCode: UInt16 = Paths.hotkeyKeyCode()
    private var pendingTask: Task<String, Error>?
    private var monitors: [Any] = []
    private var server: HelperServer?
    private var lastError: String?

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        setIcon("○")
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            if !ok { DispatchQueue.main.async { self.fail("마이크 권한이 없습니다") } }
        }
        let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        if !trusted { fail("손쉬운 사용 권한을 허용한 뒤 다시 실행하세요") }
        let handler: (NSEvent) -> Void = { [weak self] e in self?.onKey(e) }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp], handler: handler) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp], handler: { e in handler(e); return e }) { monitors.append(m) }
        do {
            server = try HelperServer(onStart: { [weak self] in self?.begin() }, onStop: { [weak self] in self?.end() })
            server?.start()
        } catch { fail("47614 포트를 열 수 없습니다: \(error.localizedDescription)") }
    }

    private func onKey(_ e: NSEvent) {
        guard e.keyCode == keyCode else { return }
        if e.type == .keyDown { if !e.isARepeat { begin() } } else if e.type == .keyUp { end() }
    }

    private func begin() {
        guard !recorder.isRecording else { return }
        do { _ = try recorder.start() } catch { fail("녹음 시작 실패: \(error.localizedDescription)"); return }
        setIcon("●")
        // Ask the daemon for the playhead now (key-down time), while recording runs.
        let d = daemon
        pendingTask = Task { try await d.keyDown() }
    }

    private func end() {
        guard let (wav, dur) = recorder.stop() else { return }
        let task = pendingTask
        pendingTask = nil
        setIcon("○")
        let d = daemon
        Task { @MainActor in
            do {
                guard let task else { throw NSError(domain: "Helper", code: 0, userInfo: [NSLocalizedDescriptionKey: "no pending key-down"]) }
                let id = try await task.value
                try await d.keyUp(pendingId: id, wav: wav, durationSec: dur)
                self.lastError = nil
                self.setIcon("○")
            } catch {
                // Keep the WAV; the user can see the error in the menu.
                self.fail("데몬 전달 실패: \(error.localizedDescription)")
            }
        }
    }

    private func fail(_ msg: String) {
        lastError = msg
        setIcon("⚠")
        NSLog("VoiceHotkey: %@", msg)
        buildMenu()
    }

    private func setIcon(_ s: String) { status.button?.title = s }

    private func buildMenu() {
        let m = NSMenu()
        m.addItem(withTitle: "음성 지시 단축키 (keyCode \(keyCode))", action: nil, keyEquivalent: "")
        if let e = lastError { m.addItem(withTitle: "⚠ \(e)", action: nil, keyEquivalent: "") }
        m.addItem(.separator())
        let reload = NSMenuItem(title: "설정 다시 읽기", action: #selector(reloadSettings), keyEquivalent: "")
        reload.target = self
        m.addItem(reload)
        m.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = m
    }

    @objc private func reloadSettings() {
        keyCode = Paths.hotkeyKeyCode()
        lastError = nil
        setIcon("○")
        buildMenu()
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
