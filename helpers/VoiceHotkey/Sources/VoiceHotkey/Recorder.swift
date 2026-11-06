import AVFoundation
import Foundation

/// 16 kHz mono 16-bit PCM WAV — what scripts/voice_orders_stt.py reads without PyAV.
final class Recorder {
    private var recorder: AVAudioRecorder?
    private var startedAt: Date?
    private(set) var url: URL?

    var isRecording: Bool { recorder?.isRecording ?? false }

    func start() throws -> URL {
        try FileManager.default.createDirectory(at: Paths.recordings, withIntermediateDirectories: true)
        let url = Paths.recordings.appendingPathComponent("\(UUID().uuidString.lowercased()).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        guard r.record() else { throw NSError(domain: "Recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "record() returned false (microphone permission?)"]) }
        recorder = r
        startedAt = Date()
        self.url = url
        return url
    }

    /// Stops and returns (file, seconds recorded).
    func stop() -> (URL, Double)? {
        guard let r = recorder, let url = url, let t0 = startedAt else { return nil }
        let dur = r.currentTime > 0 ? r.currentTime : Date().timeIntervalSince(t0)
        r.stop()
        recorder = nil
        startedAt = nil
        return (url, dur)
    }
}
